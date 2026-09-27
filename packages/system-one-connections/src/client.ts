import { createSystemOne, type EvaluateRequest, type EvaluationResult, type Questions, type RequestOptions } from "@system-one-ai/core";
import { systemOneAdapter } from "@system-one-ai/adapter-system-one";
import { createFetchTransport } from "@system-one-ai/transport-fetch";
import { validateConnectionCatalog, type ConnectionCatalog } from "./catalog.js";
import { ConnectionSelectionError, MissingConnectionKeyError } from "./errors.js";

export interface ConnectionOverrides {
  /** Owner-selected named connection for this call only. */
  readonly connectionId?: string;
  /** Owner-selected model for this call only. */
  readonly model?: string;
}

export interface ConnectionSnapshot {
  readonly connectionId: string;
  readonly baseURL: string;
  readonly model: string;
  readonly apiKeyEnv?: string;
}

export type ConnectionEvaluateRequest<Q extends Questions = Questions> = Omit<EvaluateRequest<Q>, "model">;
export type ConnectionRequestOptions = Omit<RequestOptions, "maxRetries">;

export interface ConnectionEvaluationClient {
  evaluate<const Q extends Questions>(
    request: ConnectionEvaluateRequest<Q>,
    options?: ConnectionRequestOptions,
  ): Promise<EvaluationResult<Q>>;
}

export interface ConnectedSystemOneClient {
  /** Frozen configuration selected before evaluation; it does not change if the catalog is later edited. */
  readonly connection: ConnectionSnapshot;
  /** SDK client pinned to this connection and model, with retries disabled. */
  readonly client: ConnectionEvaluationClient;
}

export interface CreateConnectionClientOptions {
  /** Injectable environment for tests and embedding applications. Read lazily when evaluate starts. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectionSelectionError("Connection overrides must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConnectionSelectionError("Connection overrides must be a plain object.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (
      typeof key !== "string" ||
      !["connectionId", "model"].includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new ConnectionSelectionError("Connection overrides contain an unsupported field.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** Resolve the configured default or explicit owner selection into an immutable per-call snapshot. */
export function resolveConnection(
  value: ConnectionCatalog,
  overrides: ConnectionOverrides = {},
): ConnectionSnapshot {
  const catalog = validateConnectionCatalog(value);
  const selection = plainRecord(overrides);
  const requestedId = selection.connectionId;
  if (requestedId !== undefined && (typeof requestedId !== "string" || requestedId.trim() !== requestedId || requestedId.length === 0)) {
    throw new ConnectionSelectionError("connectionId must be a nonempty configured connection ID.");
  }
  const connectionId = requestedId ?? catalog.default;
  if (connectionId === undefined) {
    throw new ConnectionSelectionError("No connection was selected and the catalog has no default.");
  }
  if (!Object.hasOwn(catalog.connections, connectionId)) {
    throw new ConnectionSelectionError("The selected connection is not configured.");
  }

  const requestedModel = selection.model;
  if (requestedModel !== undefined && (typeof requestedModel !== "string" || requestedModel.length === 0 || requestedModel.trim() !== requestedModel)) {
    throw new ConnectionSelectionError("model must be a nonempty string without surrounding whitespace.");
  }
  const configured = catalog.connections[connectionId]!;
  return Object.freeze({
    connectionId,
    baseURL: configured.baseURL,
    model: requestedModel ?? configured.model,
    ...(configured.apiKeyEnv === undefined ? {} : { apiKeyEnv: configured.apiKeyEnv }),
  });
}

/**
 * Construct the shared native SDK client. Connection and model overrides affect this client only;
 * API keys are looked up lazily by the configured environment-variable name.
 */
export function createConnectionClient(
  catalog: ConnectionCatalog,
  overrides: ConnectionOverrides = {},
  options: CreateConnectionClientOptions = {},
): ConnectedSystemOneClient {
  const connection = resolveConnection(catalog, overrides);
  const env = options.env ?? process.env;
  const sdk = createSystemOne({
    baseURL: connection.baseURL,
    model: connection.model,
    adapter: systemOneAdapter,
    transport: createFetchTransport(),
    apiKey: connection.apiKeyEnv === undefined
      ? null
      : () => {
          const key = env[connection.apiKeyEnv!];
          if (typeof key !== "string" || key.length === 0) {
            throw new MissingConnectionKeyError(connection.apiKeyEnv!);
          }
          return key;
        },
    maxRetries: 0,
  });

  const client: ConnectionEvaluationClient = Object.freeze({
    async evaluate<const Q extends Questions>(
      request: ConnectionEvaluateRequest<Q>,
      requestOptions: ConnectionRequestOptions = {},
    ): Promise<EvaluationResult<Q>> {
      if (request === null || typeof request !== "object" || "model" in request) {
        throw new ConnectionSelectionError("Select a model through the owner-controlled client override, not the request.");
      }
      return sdk.evaluate(request, { ...requestOptions, maxRetries: 0 });
    },
  });

  return Object.freeze({ connection, client });
}

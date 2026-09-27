#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  ConnectionCatalogError,
  ConnectionSelectionError,
  MissingConnectionKeyError,
  createConnectionClient,
  loadConnectionCatalog,
  type ConnectionEvaluateRequest,
} from "@cartwmic/system-one-connections";

interface CliOptions {
  readonly help: boolean;
  readonly file?: string;
  readonly connectionId?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

class CliFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

const HELP = `Usage: system-one [options]

Submit one SDK-shaped JSON request on stdin, or read it from --file PATH.

Options:
  --file PATH          Read the request JSON from PATH instead of stdin
  --connection ID      Use this configured connection for this call only
  --model MODEL        Override the configured model for this call only
  --timeout-ms MS      Set a positive total evaluation timeout
  -h, --help           Show this help

Request JSON:
  {"state": ..., "questions": { ... }, "providerOptions": { ... }}
  Omit providerOptions when it is not needed. Put model selection in --model.
  Questions use the SDK's Choice, Boolean, and Score shapes.

Success writes one JSON object to stdout: the SDK result fields plus
connectionId. Failure writes one sanitized {"error":{"code","message"}}
JSON object to stderr, exits nonzero, and leaves stdout empty. The command
makes one attempt and never falls back to another connection or model.

Use it for atomic, specific judgments over sufficient relevant evidence.
Do not use a decision model for factual lookup, exact calculations, vague
impressions, open-ended generation, or substantial multi-step reasoning.
Confidence is not permission to act. Only include the evidence and questions
needed for this call.
`;

function parseArgs(args: readonly string[]): CliOptions {
  const seen = new Set<string>();
  let help = false;
  let file: string | undefined;
  let connectionId: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;

  function valueAfter(index: number, option: string): string {
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new CliFailure("USAGE_ERROR", `Expected a value after ${option}.`);
    }
    return value;
  }

  function mark(option: string): void {
    if (seen.has(option)) throw new CliFailure("USAGE_ERROR", `${option} may be used only once.`);
    seen.add(option);
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    switch (argument) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--file":
        mark(argument);
        file = valueAfter(index, argument);
        index += 1;
        break;
      case "--connection":
        mark(argument);
        connectionId = valueAfter(index, argument);
        index += 1;
        break;
      case "--model":
        mark(argument);
        model = valueAfter(index, argument);
        index += 1;
        break;
      case "--timeout-ms": {
        mark(argument);
        const value = valueAfter(index, argument);
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new CliFailure("USAGE_ERROR", "--timeout-ms must be a positive safe integer.");
        }
        timeoutMs = Number(value);
        index += 1;
        break;
      }
      default:
        throw new CliFailure("USAGE_ERROR", "Unknown option or unexpected argument.");
    }
  }

  return {
    help,
    ...(file === undefined ? {} : { file }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

async function readStdin(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onClose);
      process.stdin.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onClose = () => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = () => finish(() => reject(new CliFailure("INPUT_READ_ERROR", "Could not read JSON from stdin.")));
    const onAbort = () => finish(() => reject(new CliFailure("CANCELLED", "Input was cancelled.", 1)));

    if (process.stdin.readableEnded || process.stdin.destroyed) {
      resolve("");
      return;
    }
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onClose);
    process.stdin.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else process.stdin.resume();
  });
}

async function readRequest(options: CliOptions, signal: AbortSignal): Promise<ConnectionEvaluateRequest> {
  let text: string;
  if (options.file !== undefined) {
    try {
      text = await readFile(options.file, "utf8");
    } catch {
      throw new CliFailure("INPUT_READ_ERROR", "Could not read the request file.");
    }
  } else {
    text = await readStdin(signal);
  }
  if (signal.aborted) throw new CliFailure("CANCELLED", "Input was cancelled.", 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CliFailure("INVALID_JSON", "Input must be one valid JSON object.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliFailure("INVALID_INPUT", "Input must be a JSON object containing state and questions.");
  }

  const input = parsed as Record<string, unknown>;
  if (Object.hasOwn(input, "model")) {
    throw new CliFailure("INVALID_INPUT", "Set the model with --model, not in the JSON request.");
  }
  if (Object.keys(input).some(key => !["state", "questions", "providerOptions"].includes(key))) {
    throw new CliFailure("INVALID_INPUT", "Input contains an unsupported field.");
  }
  if (!Object.hasOwn(input, "state") || !Object.hasOwn(input, "questions")) {
    throw new CliFailure("INVALID_INPUT", "Input must contain state and questions.");
  }

  return {
    state: input.state as ConnectionEvaluateRequest["state"],
    questions: input.questions as ConnectionEvaluateRequest["questions"],
    ...(Object.hasOwn(input, "providerOptions")
      ? { providerOptions: input.providerOptions as NonNullable<ConnectionEvaluateRequest["providerOptions"]> }
      : {}),
  };
}

interface PublicError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function formatError(error: unknown, cancelled: boolean): PublicError {
  if (cancelled) return { code: "CANCELLED", message: "The evaluation was cancelled." };
  if (error instanceof CliFailure) return { code: error.code, message: error.message };
  if (error instanceof ConnectionCatalogError) {
    return { code: "CONNECTION_CATALOG_ERROR", message: "The connection catalog is missing or invalid." };
  }
  if (error instanceof ConnectionSelectionError) {
    return { code: "CONNECTION_SELECTION_ERROR", message: "Select a configured connection or set a catalog default." };
  }
  if (error instanceof MissingConnectionKeyError) {
    return { code: "MISSING_CREDENTIAL", message: "The selected connection's required credential is not set." };
  }

  switch (errorCode(error)) {
    case "timeout":
      return { code: "TIMEOUT", message: "The evaluation timed out." };
    case "aborted":
      return { code: "CANCELLED", message: "The evaluation was cancelled." };
    case "response":
      return { code: "MALFORMED_RESPONSE", message: "The provider returned an invalid evaluation response." };
    case "http": {
      const candidate = typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
      return {
        code: "PROVIDER_REJECTED",
        message: "The selected provider rejected the evaluation.",
        ...(typeof candidate === "number" && Number.isInteger(candidate) ? { status: candidate } : {}),
      };
    }
    case "network":
      return { code: "NETWORK_ERROR", message: "The selected provider could not be reached." };
    case "validation":
      return { code: "INVALID_REQUEST", message: "The request is not valid for System One." };
    case "configuration":
      return { code: "PROVIDER_CONFIGURATION_ERROR", message: "The selected provider is not configured correctly." };
    case "unsupported":
      return { code: "UNSUPPORTED_REQUEST", message: "The selected provider does not support this request." };
    case "binding":
      return { code: "PROVIDER_ERROR", message: "The selected provider could not complete the evaluation." };
    default:
      return { code: "EVALUATION_FAILED", message: "The evaluation failed." };
  }
}

function jsonLine(value: unknown, secret?: string): string {
  let serialized = JSON.stringify(value);
  if (secret !== undefined && secret.length > 0) {
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    serialized = serialized.replaceAll(escapedSecret, "[REDACTED]");
  }
  return `${serialized}\n`;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    controller.abort();
  };
  const onInterrupt = () => onSignal("SIGINT");
  const onTerminate = () => onSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }

    const request = await readRequest(options, controller.signal);
    if (controller.signal.aborted) throw new CliFailure("CANCELLED", "Input was cancelled.", 1);
    const catalog = await loadConnectionCatalog();
    if (controller.signal.aborted) throw new CliFailure("CANCELLED", "Evaluation was cancelled.", 1);

    const { connection, client } = createConnectionClient(catalog, {
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    const result = await client.evaluate(request, {
      signal: controller.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (controller.signal.aborted) throw new CliFailure("CANCELLED", "Evaluation was cancelled.", 1);

    const secret = connection.apiKeyEnv === undefined ? undefined : process.env[connection.apiKeyEnv];
    process.stdout.write(jsonLine({ connectionId: connection.connectionId, ...result }, secret));
    process.exitCode = 0;
  } catch (error) {
    const failure = formatError(error, controller.signal.aborted);
    process.stderr.write(jsonLine({ error: failure }));
    process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

void main();

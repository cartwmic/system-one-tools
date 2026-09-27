import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ConnectionCatalogError } from "./errors.js";

export type ConnectionAdapter = "system-one" | "openrouter";

export interface Connection {
  /** Omitted connections use the native System One adapter. */
  readonly adapter?: ConnectionAdapter;
  readonly baseURL: string;
  readonly model: string;
  /** Name of the environment variable holding the key; the key itself is never stored. */
  readonly apiKeyEnv?: string;
}

export interface ConnectionCatalog {
  readonly version: 1;
  /** Omit to require callers to select a connection explicitly. */
  readonly default?: string;
  readonly connections: Readonly<Record<string, Connection>>;
}

const CATALOG_DIR = "system-one";
const CATALOG_FILE = "connections.json";
const CONNECTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The shared user-global catalog path, honoring XDG_CONFIG_HOME when set. */
export function getDefaultCatalogPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(configHome, CATALOG_DIR, CATALOG_FILE);
}

function record(
  value: unknown,
  path: string,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectionCatalogError(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConnectionCatalogError(`${path} must be a plain object.`);
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (allowedKeys !== undefined && !allowedKeys.includes(key))) {
      throw new ConnectionCatalogError(`${path} contains an unsupported field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new ConnectionCatalogError(`${path}.${key} must be a plain data field.`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ConnectionCatalogError(`${path} must be a nonempty string without surrounding whitespace.`);
  }
  return value;
}

function baseURL(value: unknown, path: string): string {
  const raw = nonemptyString(value, path);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectionCatalogError(`${path} must be an absolute HTTP(S) base URL.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ConnectionCatalogError(`${path} must use HTTP(S) and contain no credentials, query, or fragment.`);
  }
  return url.toString().replace(/\/+$/, "");
}

/** Validate and freeze a version-1 catalog. Unknown fields (including credential values) are rejected. */
export function validateConnectionCatalog(value: unknown): ConnectionCatalog {
  const input = record(value, "catalog", ["version", "default", "connections"]);
  if (input.version !== 1) {
    throw new ConnectionCatalogError("catalog.version must be 1.");
  }

  const rawConnections = record(input.connections, "catalog.connections");
  const connections: Record<string, Connection> = Object.create(null) as Record<string, Connection>;
  for (const [id, value] of Object.entries(rawConnections)) {
    if (!CONNECTION_ID.test(id)) {
      throw new ConnectionCatalogError("Connection IDs must start with a letter and contain only letters, digits, '_' or '-'.");
    }
    const entry = record(value, `catalog.connections.${id}`, ["adapter", "baseURL", "model", "apiKeyEnv"]);
    let adapter: ConnectionAdapter | undefined;
    if (entry.adapter !== undefined) {
      if (entry.adapter !== "system-one" && entry.adapter !== "openrouter") {
        throw new ConnectionCatalogError(`catalog.connections.${id}.adapter must be system-one or openrouter.`);
      }
      adapter = entry.adapter;
    }
    const connection: Connection = {
      ...(adapter === undefined ? {} : { adapter }),
      baseURL: baseURL(entry.baseURL, `catalog.connections.${id}.baseURL`),
      model: nonemptyString(entry.model, `catalog.connections.${id}.model`),
      ...(entry.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: nonemptyString(entry.apiKeyEnv, `catalog.connections.${id}.apiKeyEnv`) }),
    };
    if (connection.apiKeyEnv !== undefined && !ENV_NAME.test(connection.apiKeyEnv)) {
      throw new ConnectionCatalogError(`catalog.connections.${id}.apiKeyEnv must be an environment-variable name.`);
    }
    connections[id] = Object.freeze(connection);
  }

  if (Object.keys(connections).length === 0) {
    throw new ConnectionCatalogError("catalog.connections must contain at least one connection.");
  }

  let defaultConnection: string | undefined;
  if (input.default !== undefined) {
    defaultConnection = nonemptyString(input.default, "catalog.default");
    if (!Object.hasOwn(connections, defaultConnection)) {
      throw new ConnectionCatalogError("catalog.default must name a configured connection.");
    }
  }

  return Object.freeze({
    version: 1 as const,
    ...(defaultConnection === undefined ? {} : { default: defaultConnection }),
    connections: Object.freeze(connections),
  });
}

/** Load and validate the shared user-global catalog. No credentials are read from this file. */
export async function loadConnectionCatalog(
  filePath = getDefaultCatalogPath(),
): Promise<ConnectionCatalog> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT") {
      throw new ConnectionCatalogError(`Connection catalog not found at ${filePath}.`);
    }
    throw new ConnectionCatalogError(`Could not read connection catalog at ${filePath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ConnectionCatalogError(`Connection catalog at ${filePath} is not valid JSON.`);
  }
  return validateConnectionCatalog(parsed);
}

/** Atomically write a validated catalog with owner-only file permissions. */
export async function writeConnectionCatalog(
  value: unknown,
  filePath = getDefaultCatalogPath(),
): Promise<ConnectionCatalog> {
  const catalog = validateConnectionCatalog(value);
  const destination = resolve(filePath);
  const directory = dirname(destination);
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    return catalog;
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new ConnectionCatalogError(`Could not safely write connection catalog at ${destination}.`);
  }
}

/** Read, transform, validate, and atomically replace a catalog for settings UIs. */
export async function updateConnectionCatalog(
  update: (current: ConnectionCatalog) => unknown | Promise<unknown>,
  filePath = getDefaultCatalogPath(),
): Promise<ConnectionCatalog> {
  if (typeof update !== "function") {
    throw new TypeError("update must be a function.");
  }
  const current = await loadConnectionCatalog(filePath);
  return writeConnectionCatalog(await update(current), filePath);
}

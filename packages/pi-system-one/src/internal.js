import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SYSTEM_ONE_API_CHANNEL = "cartwmic:pi-system-one:api";
export const SYSTEM_ONE_SESSION_ENTRY = "cartwmic:pi-system-one:session";
export const USAGE_MODES = Object.freeze(["explicit", "selective", "proactive", "custom"]);

const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  agentAccess: false,
  defaultMode: "selective",
  defaultClassifier: null,
});

export function isUsageMode(value) {
  return typeof value === "string" && USAGE_MODES.includes(value);
}

function agentDirectory(env = process.env) {
  return resolve(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent"));
}

export function getSystemOnePreferencesPath(env = process.env) {
  return join(agentDirectory(env), "system-one", "preferences.json");
}

export function getCustomGuidancePath(env = process.env) {
  return join(agentDirectory(env), "system-one", "custom-guidance.md");
}

export async function loadSystemOnePreferences(env = process.env) {
  try {
    const text = await readFile(getSystemOnePreferencesPath(env), "utf8");
    const value = JSON.parse(text);
    if (!isPlainObject(value) || value.version !== 1) return DEFAULT_PREFERENCES;
    return Object.freeze({
      version: 1,
      agentAccess: typeof value.agentAccess === "boolean" ? value.agentAccess : false,
      defaultMode: isUsageMode(value.defaultMode) ? value.defaultMode : "selective",
      defaultClassifier: isClassifierSelection(value.defaultClassifier) ? Object.freeze({ ...value.defaultClassifier }) : null,
    });
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export async function saveSystemOnePreferences(value, env = process.env) {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    typeof value.agentAccess !== "boolean" ||
    !isUsageMode(value.defaultMode) ||
    (value.defaultClassifier != null && !isClassifierSelection(value.defaultClassifier)) ||
    Object.keys(value).some((key) => !["version", "agentAccess", "defaultMode", "defaultClassifier"].includes(key))
  ) {
    throw new TypeError("System One preferences must contain version 1, boolean agentAccess, and a supported defaultMode.");
  }
  const path = getSystemOnePreferencesPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return loadSystemOnePreferences(env);
}

export async function loadCustomGuidance(env = process.env) {
  try {
    return await readFile(getCustomGuidancePath(env), "utf8");
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return undefined;
    throw new Error("Could not read the user-global System One custom guidance.");
  }
}

export async function saveCustomGuidance(text, env = process.env) {
  if (typeof text !== "string") throw new TypeError("Custom guidance must be text.");
  const path = getCustomGuidancePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

/** Obtain the in-process API provided by the pi-system-one extension. */
export function getSystemOneApi(pi) {
  let api;
  pi.events.emit(SYSTEM_ONE_API_CHANNEL, {
    provide(value) {
      api = value;
    },
  });
  if (!api) throw new Error("The @cartwmic/pi-system-one extension is not loaded in this Pi session.");
  return api;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isErrno(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

export function isClassifierSelection(value) {
  return isPlainObject(value) && Object.keys(value).length === 2 &&
    [value.provider, value.id].every((item) => typeof item === "string" && item.length > 0 && item.trim() === item);
}

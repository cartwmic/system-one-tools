import { access } from "node:fs/promises";
import {
  getDefaultCatalogPath,
  loadConnectionCatalog,
  writeConnectionCatalog,
} from "@cartwmic/system-one-connections";
import {
  getSystemOneApi,
  loadCustomGuidance,
  loadSystemOnePreferences,
  saveCustomGuidance,
  saveSystemOnePreferences,
  USAGE_MODES,
} from "./internal.js";

const MODES = Object.freeze([...USAGE_MODES]);
const MODE_LABELS = Object.freeze({
  explicit: "Explicit",
  selective: "Selective",
  proactive: "Proactive",
  custom: "Custom",
});
const SUBCOMMANDS = Object.freeze([
  "on", "off", "use", "mode", "status", "ask", "settings", "guidance", "reset",
]);

const SAMPLE_REQUEST = {
  state: { evidence: "Replace this with relevant evidence." },
  questions: {
    judgment: {
      type: "choice",
      instructions: "Which option is better supported by the supplied evidence?",
      criteria: { first: "First option", second: "Second option" },
    },
  },
};

/** Register the single /so command family alongside the System One agent tool. */
export function registerSystemOneUi(pi) {
  pi.registerCommand("so", {
    description: "System One access, connection, mode, status, manual ask, and settings",
    getArgumentCompletions(prefix) {
      const first = prefix.trim().split(/\s+/, 1)[0] ?? "";
      if (!prefix.includes(" ")) {
        const matches = SUBCOMMANDS.filter((command) => command.startsWith(first));
        return matches.map((value) => ({ value, label: value }));
      }
      if (first === "mode") {
        const partial = prefix.slice(prefix.indexOf("mode") + "mode".length).trim();
        return MODES.filter((mode) => mode.startsWith(partial)).map((value) => ({
          value,
          label: MODE_LABELS[value],
        }));
      }
      return null;
    },
    async handler(args, ctx) {
      try {
        await dispatch(args, ctx, () => getSystemOneApi(pi));
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}

async function dispatch(rawArgs, ctx, getApi) {
  const args = rawArgs.trim();
  if (!args) {
    const selected = await ctx.ui.select("System One", [
      "status", "on", "off", "use", "mode", "ask", "settings", "guidance", "reset",
    ]);
    if (selected) await dispatch(selected, ctx, getApi);
    return;
  }

  const [command, ...rest] = args.split(/\s+/);
  const api = getApi();
  if (command === "on" || command === "off") {
    requireNoArguments(command, rest);
    await api.setSessionAccess(command === "on");
    ctx.ui.notify(`System One agent access is ${command} for this session.`, "info");
    return;
  }
  if (command === "use") {
    if (rest.length > 1) throw new Error("Usage: /so use [connection-id]");
    const id = rest[0];
    if (id === "default") {
      await api.setSessionUse(null);
      ctx.ui.notify("System One now uses the catalog default for this session.", "info");
      return;
    }
    if (id) {
      await api.setSessionUse(id);
      ctx.ui.notify(`System One connection set to ${id} for this session.`, "info");
      return;
    }
    const catalog = await loadConnectionCatalog(getDefaultCatalogPath(process.env));
    const options = ["Catalog default", ...Object.keys(catalog.connections)];
    const selected = await ctx.ui.select("System One session connection", options);
    if (selected === undefined) return;
    await api.setSessionUse(selected === "Catalog default" ? null : selected);
    ctx.ui.notify(selected === "Catalog default"
      ? "System One now uses the catalog default for this session."
      : `System One connection set to ${selected} for this session.`, "info");
    return;
  }
  if (command === "mode") {
    if (rest.length > 1) throw new Error(`Usage: /so mode [${MODES.join("|")}]`);
    let mode = rest[0];
    if (mode && !MODES.includes(mode)) throw new Error(`Mode must be one of: ${MODES.join(", ")}.`);
    if (!mode) {
      const selected = await ctx.ui.select("System One session prompting mode", MODES.map((value) => MODE_LABELS[value]));
      if (selected === undefined) return;
      mode = Object.keys(MODE_LABELS).find((key) => MODE_LABELS[key] === selected);
    }
    await api.setSessionMode(mode);
    ctx.ui.notify(`System One session mode set to ${MODE_LABELS[mode]}.`, "info");
    return;
  }
  if (command === "status") {
    requireNoArguments(command, rest);
    ctx.ui.notify(formatStatus(await api.getStatus()), "info");
    return;
  }
  if (command === "reset") {
    requireNoArguments(command, rest);
    await api.restoreDefaults();
    ctx.ui.notify("System One session overrides were cleared; user defaults are active.", "info");
    return;
  }
  if (command === "ask") {
    requireNoArguments(command, rest);
    await ask(ctx, api);
    return;
  }
  if (command === "settings") {
    requireNoArguments(command, rest);
    await settings(ctx);
    return;
  }
  if (command === "guidance") {
    requireNoArguments(command, rest);
    await editGuidance(ctx);
    return;
  }
  throw new Error(`Unknown /so action "${command}". Use /so for the action menu.`);
}

async function ask(ctx, api) {
  const requestText = await ctx.ui.editor(
    "System One request JSON (state and questions only)",
    JSON.stringify(SAMPLE_REQUEST, null, 2),
  );
  if (requestText === undefined) return;

  let request;
  try {
    request = JSON.parse(requestText);
  } catch (error) {
    throw new Error(`Request is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }

  const catalog = await loadConnectionCatalog(getDefaultCatalogPath(process.env));
  const status = await api.getStatus();
  const connectionIds = Object.keys(catalog.connections);
  const preferredId = status.sessionConnectionId ?? catalog.default ?? status.activeConnectionId;
  const orderedIds = preferredId && connectionIds.includes(preferredId)
    ? [preferredId, ...connectionIds.filter((id) => id !== preferredId)]
    : connectionIds;
  const connectionId = await ctx.ui.select("Connection for this call only", orderedIds);
  if (connectionId === undefined) return;

  const model = await ctx.ui.input(
    "Model override for this call (leave blank for the connection default)",
    catalog.connections[connectionId].model,
  );
  if (model === undefined) return;

  const result = await api.evaluateManual(request, {
    connectionId,
    ...(model.trim() ? { model: model.trim() } : {}),
  });
  await ctx.ui.editor(
    "System One result — terminal only; edits are discarded",
    JSON.stringify(result, null, 2),
  );
}

async function settings(ctx) {
  const action = await ctx.ui.select("System One settings", [
    "Manage connections",
    "Set catalog default connection",
    "Set persistent agent defaults",
    "Edit custom guidance",
  ]);
  if (action === undefined) return;
  if (action === "Manage connections") return manageConnections(ctx);
  if (action === "Set catalog default connection") return setCatalogDefault(ctx);
  if (action === "Set persistent agent defaults") return setPersistentDefaults(ctx);
  if (action === "Edit custom guidance") return editGuidance(ctx);
}

async function manageConnections(ctx) {
  const path = getDefaultCatalogPath(process.env);
  const catalog = await loadCatalogIfPresent(path);
  const choices = ["Create a connection", ...Object.keys(catalog?.connections ?? {})];
  const selected = await ctx.ui.select("Connection catalog", choices);
  if (selected === undefined) return;

  const isNew = selected === "Create a connection";
  let id = selected;
  if (isNew) {
    id = await ctx.ui.input("New connection ID (letters, digits, _ or -)", "local");
    if (id === undefined) return;
    if (catalog && Object.hasOwn(catalog.connections, id)) {
      throw new Error(`Connection ${id} already exists; choose it to edit instead.`);
    }
  }

  const existing = catalog?.connections[id];
  const adapterChoice = await ctx.ui.select("Decision adapter", existing?.adapter === "openrouter"
    ? ["OpenRouter Decisions", "System One"]
    : ["System One", "OpenRouter Decisions"]);
  if (adapterChoice === undefined) return;
  const openrouter = adapterChoice === "OpenRouter Decisions";
  const previous = existing && (existing.adapter ?? "system-one") === (openrouter ? "openrouter" : "system-one")
    ? existing : undefined;
  const baseURL = await ctx.ui.input("Compatible System One base URL", previous?.baseURL ?? (openrouter
    ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:8317/v1"));
  if (baseURL === undefined) return;
  const model = await ctx.ui.input("Default model ID", previous?.model ?? (openrouter
    ? "~typesafe/jev-latest" : "system-one-model"));
  if (model === undefined) return;
  const apiKeyEnv = await ctx.ui.input("Credential environment-variable name (blank for none)", previous?.apiKeyEnv ?? (openrouter
    ? "OPENROUTER_API_KEY" : ""));
  if (apiKeyEnv === undefined) return;

  const connections = { ...(catalog?.connections ?? {}), [id]: {
    ...(openrouter ? { adapter: "openrouter" } : {}),
    baseURL: baseURL.trim(),
    model: model.trim(),
    ...(apiKeyEnv.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
  } };
  const next = {
    version: 1,
    ...(catalog?.default ? { default: catalog.default } : {}),
    connections,
  };
  await writeConnectionCatalog(next, path);
  ctx.ui.notify(`Saved connection ${id} to the shared System One catalog.`, "info");
}

async function setCatalogDefault(ctx) {
  const path = getDefaultCatalogPath(process.env);
  const catalog = await loadCatalogIfPresent(path);
  if (!catalog) throw new Error("No connection catalog exists yet. Use /so settings to create a connection first.");

  const noDefault = "(no default)";
  const ids = Object.keys(catalog.connections);
  const choices = [
    ...(catalog.default ? [catalog.default] : []),
    ...ids.filter((id) => id !== catalog.default),
    noDefault,
  ];
  const selected = await ctx.ui.select("Default System One connection", choices);
  if (selected === undefined) return;
  await writeConnectionCatalog({
    version: 1,
    ...(selected === noDefault ? {} : { default: selected }),
    connections: catalog.connections,
  }, path);
  ctx.ui.notify(selected === noDefault
    ? "The catalog has no default; callers must select a connection."
    : `Catalog default set to ${selected}.`, "info");
}

async function setPersistentDefaults(ctx) {
  const current = await loadSystemOnePreferences(process.env);
  const access = await ctx.ui.select("Persistent agent-access default", [
    current.agentAccess ? "On" : "Off",
    current.agentAccess ? "Off" : "On",
  ]);
  if (access === undefined) return;

  const modes = [current.defaultMode, ...MODES.filter((mode) => mode !== current.defaultMode)];
  const selectedMode = await ctx.ui.select(
    "Persistent prompting-mode default",
    modes.map((mode) => MODE_LABELS[mode]),
  );
  if (selectedMode === undefined) return;
  const defaultMode = Object.keys(MODE_LABELS).find((mode) => MODE_LABELS[mode] === selectedMode);
  const saved = await saveSystemOnePreferences({
    version: 1,
    agentAccess: access === "On",
    defaultMode,
  }, process.env);
  ctx.ui.notify(
    `Saved user-global defaults: agent access ${saved.agentAccess ? "on" : "off"}, mode ${MODE_LABELS[saved.defaultMode]}. Session overrides are unchanged.`,
    "info",
  );
}

async function editGuidance(ctx) {
  let current;
  try {
    current = await loadCustomGuidance(process.env);
  } catch {
    throw new Error("Could not read the user-global custom guidance file.");
  }
  const text = await ctx.ui.editor(
    "Edit custom System One guidance (Ctrl+G opens Pi's configured external editor)",
    current ?? "",
  );
  if (text === undefined) return;
  await saveCustomGuidance(text, process.env);
  ctx.ui.notify("Saved user-global custom guidance. Fixed System One boundaries remain in force.", "info");
}

async function loadCatalogIfPresent(path) {
  try {
    await access(path);
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return undefined;
    throw new Error("Could not access the shared System One connection catalog.");
  }
  return loadConnectionCatalog(path);
}

function formatStatus(status) {
  const accessSource = status.sessionAgentAccess === null
    ? "user default"
    : "session override";
  const modeSource = status.sessionMode === null
    ? "user default"
    : "session override";
  const connectionSource = status.sessionConnectionId !== null
    ? "session override"
    : status.activeConnectionId === null
      ? "no catalog default"
      : "catalog default";
  const connection = status.activeConnectionId === null
    ? "not selected"
    : `${status.activeConnectionId} (${status.connectionAvailable ? "available" : "not configured"})`;
  return [
    "System One status",
    `Agent access: ${status.agentAccess ? "on" : "off"} (${accessSource}; persistent default ${status.defaultAgentAccess ? "on" : "off"})`,
    `Connection: ${connection} (${connectionSource})`,
    `Prompt mode: ${MODE_LABELS[status.mode]} (${modeSource}; persistent default ${MODE_LABELS[status.defaultMode]})`,
  ].join("\n");
}

function requireNoArguments(command, rest) {
  if (rest.length > 0) throw new Error(`Usage: /so ${command}`);
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 500) || "System One command failed.";
}

function isErrno(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

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
    description: "System One access, classifier, mode, status, manual ask, and settings",
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
    if (rest.length && !(rest.length === 1 && rest[0] === "default") && rest.length !== 2) {
      throw new Error("Usage: /so use [provider id|default]");
    }
    const classifier = rest[0] === "default" ? null : rest.length === 2
      ? { provider: rest[0], id: rest[1] }
      : await selectClassifier(ctx, "System One session classifier", "Persistent default");
    if (classifier === undefined) return;
    await api.setSessionUse(classifier, ctx);
    ctx.ui.notify(classifier ? `System One session classifier: ${identity(classifier)}.`
      : "System One now uses the persistent default for this session.", "info");
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
    ctx.ui.notify(formatStatus(await api.getStatus(ctx)), "info");
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

  const classifier = await selectClassifier(ctx, "Classifier for this call only");
  if (classifier === undefined) return;
  let evaluation;
  try {
    evaluation = await api.evaluateManual(request, { classifier }, ctx);
  } catch {
    ctx.ui.notify("System One manual evaluation failed; no usable result. Check the request and Pi classifier/auth setup.", "error");
    return;
  }
  const result = evaluation.result;
  const failed = result.stopReason !== "stop";
  const usage = result.usage;
  const display = {
    classifier: evaluation.classifier,
    stopReason: result.stopReason,
    ...(failed ? { error: "Native evaluation failed or aborted; no usable answers." } : { answers: result.answers }),
    usage: usage ? {
      input: usage.input, output: usage.output,
      cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
    } : "Token usage unavailable",
    estimatedCatalogCostUSD: Number.isFinite(usage?.cost?.total)
      ? usage.cost.total : "Catalog cost unavailable",
  };
  await ctx.ui.editor(
    `System One ${failed ? "failed/aborted" : "result"} — terminal only; edits are discarded`,
    JSON.stringify(display, null, 2),
  );
}

function identity(classifier) {
  return JSON.stringify([classifier.provider, classifier.id]);
}

async function selectClassifier(ctx, title, defaultLabel) {
  let models;
  try {
    models = await ctx.modelRegistry.getAvailableOfType("classifier");
  } catch {
    throw new Error("Could not discover native classifiers. Check Pi provider/auth setup.");
  }
  const options = [...new Map(models.map(({ provider, id }) => {
    const selection = { provider, id };
    return [identity(selection), selection];
  })).entries()];
  if (!options.length && !defaultLabel) {
    throw new Error("No available native classifiers. Configure providers and authentication in Pi.");
  }
  const selected = await ctx.ui.select(title, [
    ...(defaultLabel ? [defaultLabel] : []), ...options.map(([label]) => label),
  ]);
  if (selected === undefined) return undefined;
  return selected === defaultLabel ? null : options.find(([label]) => label === selected)?.[1];
}

async function settings(ctx) {
  const action = await ctx.ui.select("System One settings", [
    "Set persistent classifier", "Set persistent agent defaults", "Edit custom guidance", "Provider/auth setup",
  ]);
  if (action === "Set persistent classifier") {
    const classifier = await selectClassifier(ctx, "Persistent System One classifier", "No default");
    if (classifier === undefined) return;
    const current = await loadSystemOnePreferences(process.env);
    await saveSystemOnePreferences({ ...current, defaultClassifier: classifier }, process.env);
    ctx.ui.notify("Saved persistent classifier. Session overrides are unchanged.", "info");
  }
  if (action === "Set persistent agent defaults") return setPersistentDefaults(ctx);
  if (action === "Edit custom guidance") return editGuidance(ctx);
  if (action === "Provider/auth setup") ctx.ui.notify("Configure native classifier providers in Pi's models.json and authentication with Pi /login or provider environment variables. System One does not manage provider credentials.", "info");
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
    ...current,
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

function formatStatus(status) {
  const accessSource = status.sessionAgentAccess === null
    ? "user default"
    : "session override";
  const modeSource = status.sessionMode === null
    ? "user default"
    : "session override";
  const classifierSource = status.sessionClassifier !== null ? "session override" : "user default";
  const classifier = status.classifier === null ? "not selected"
    : `${identity(status.classifier)} (${status.classifierAvailable ? "available" : "unavailable"})`;
  return [
    "System One status",
    `Agent access: ${status.agentAccess ? "on" : "off"} (${accessSource}; persistent default ${status.defaultAgentAccess ? "on" : "off"})`,
    `Classifier: ${classifier} (${classifierSource}; persistent default ${status.defaultClassifier ? identity(status.defaultClassifier) : "not selected"})`,
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

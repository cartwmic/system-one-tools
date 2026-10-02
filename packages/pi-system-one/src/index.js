import { Type } from "typebox";
import {
  getCustomGuidancePath,
  isUsageMode,
  isClassifierSelection,
  loadCustomGuidance,
  loadSystemOnePreferences,
  SYSTEM_ONE_API_CHANNEL,
  SYSTEM_ONE_SESSION_ENTRY,
  USAGE_MODES,
} from "./internal.js";
import { registerSystemOneUi } from "./ui.js";

export const SYSTEM_ONE_TOOL_NAME = "system_one";
export const SYSTEM_ONE_PROMPT_SECTION = "system-one-agent-usage";

const SESSION_STATE_VERSION = 1;
const CUSTOM_GUIDANCE_ERROR = "System One agent call blocked: Custom mode requires nonempty user-global guidance. Save Custom guidance or choose another mode.";

const stateSchema = Type.Record(Type.String(), Type.Unknown());

const questionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("choice"),
    instructions: Type.String(),
    criteria: Type.Record(Type.String(), Type.String(), { minProperties: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("bool"),
    instructions: Type.String(),
    criteria: Type.Object({
      true: Type.String(),
      false: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("score"),
    instructions: Type.String(),
    criteria: Type.Array(Type.String(), { minItems: 1 }),
  }, { additionalProperties: false }),
]);

export const SYSTEM_ONE_TOOL_PARAMETERS = Type.Object({
  state: stateSchema,
  questions: Type.Record(Type.String(), questionSchema, { minProperties: 1 }),
}, {
  additionalProperties: false,
  description: "One structured System One request. It has no connection, URL, model, file, transcript, or action parameter.",
});

const FIXED_GUIDANCE = [
  "Use only one atomic, specific Choice, Boolean, or Score judgment over sufficient, relevant evidence.",
  "Do not use System One for factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning.",
  "Probabilities and confidence are advisory only. They do not authorize, perform, or justify an action.",
  "Construct state and questions from relevant user-provided material or evidence you retrieved. Submit only those explicit fields; never attach conversation history, files, or repository contents automatically.",
  "The classifier is owner-controlled. Do not request or invent a destination, URL, connection ID, or model override.",
].join(" ");

const PRESET_GUIDANCE = Object.freeze({
  explicit: "Call this tool only when the user names System One or explicitly tells you to use this tool.",
  selective: "Use it only when a bounded intermediate judgment is genuinely useful to move forward and the supplied evidence is sufficient. Do not replace your own substantial reasoning.",
  proactive: "Consider more eligible bounded intermediate judgments when sufficient evidence is available and the result could materially inform the next step. Keep every fixed exclusion in force.",
});

const TOOL_DESCRIPTION = [
  "Evaluate one explicit, structured Choice, Boolean, or Score question over caller-supplied evidence.",
  "You must construct the state and questions yourself from relevant user material or evidence you retrieved.",
  "Only the provided state and questions are submitted: this tool never reads or attaches conversation history, files, or repository contents automatically.",
  "The classifier is owner-selected and cannot be set here. The result is advisory and never authorizes or performs an action.",
  "Do not use for factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning.",
].join(" ");

/** Register the single System One judgment tool and expose the pi-ui internal API. */
export default function piSystemOneExtension(pi) {
  registerSystemOneUi(pi);
  let sessionOverrides = {};

  function effectiveAccess(preferences) {
    return sessionOverrides.agentAccess ?? preferences.agentAccess;
  }

  function effectiveMode(preferences) {
    return sessionOverrides.mode ?? preferences.defaultMode;
  }

  function withSessionState(overrides = sessionOverrides) {
    const data = {
      version: SESSION_STATE_VERSION,
      overrides: {
        ...(overrides.agentAccess === undefined ? {} : { agentAccess: overrides.agentAccess }),
        ...(overrides.classifier === undefined ? {} : { classifier: overrides.classifier }),
        ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
      },
    };
    pi.appendEntry(SYSTEM_ONE_SESSION_ENTRY, data);
  }

  function decodeSessionOverrides(data) {
    if (!isPlainObject(data) || data.version !== SESSION_STATE_VERSION || !isPlainObject(data.overrides)) return undefined;
    const input = data.overrides;
    if (Object.keys(input).some((key) => !["agentAccess", "classifier", "mode"].includes(key))) return undefined;
    if (input.agentAccess !== undefined && typeof input.agentAccess !== "boolean") return undefined;
    if (input.classifier !== undefined && (!isClassifierSelection(input.classifier))) return undefined;
    if (input.mode !== undefined && !isUsageMode(input.mode)) return undefined;
    return {
      ...(input.agentAccess === undefined ? {} : { agentAccess: input.agentAccess }),
      ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    };
  }

  function restoreFromBranch(ctx) {
    let restored;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SYSTEM_ONE_SESSION_ENTRY) continue;
      const decoded = decodeSessionOverrides(entry.data);
      if (decoded !== undefined) restored = decoded;
    }
    sessionOverrides = restored ?? {};
  }

  function updateActiveTool(enabled) {
    const current = pi.getActiveTools();
    const hasTool = current.includes(SYSTEM_ONE_TOOL_NAME);
    if (enabled === hasTool) return;
    pi.setActiveTools(enabled
      ? [...current, SYSTEM_ONE_TOOL_NAME]
      : current.filter((name) => name !== SYSTEM_ONE_TOOL_NAME));
  }

  async function status(ctx) {
    const preferences = await loadSystemOnePreferences(process.env);
    const classifier = sessionOverrides.classifier ?? preferences.defaultClassifier ?? null;
    const available = classifier ? await ctx.modelRegistry.getAvailableOfType("classifier", classifier.provider) : [];
    return Object.freeze({
      agentAccess: effectiveAccess(preferences), defaultAgentAccess: preferences.agentAccess,
      sessionAgentAccess: sessionOverrides.agentAccess ?? null,
      mode: effectiveMode(preferences), defaultMode: preferences.defaultMode,
      sessionMode: sessionOverrides.mode ?? null,
      classifier, defaultClassifier: preferences.defaultClassifier ?? null,
      sessionClassifier: sessionOverrides.classifier ?? null,
      classifierAvailable: classifier !== null && available.some((model) => model.provider === classifier.provider && model.id === classifier.id),
    });
  }

  async function setSessionAccess(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Session access must be on or off.");
    sessionOverrides = { ...sessionOverrides, agentAccess: enabled };
    withSessionState();
    updateActiveTool(enabled);
  }

  async function setSessionUse(classifier, ctx) {
    if (classifier !== undefined && classifier !== null) {
      if (!isClassifierSelection(classifier)) throw new TypeError("Select a classifier by provider and id.");
      if (!ctx.modelRegistry.getModelOfType("classifier", classifier.provider, classifier.id)) throw new Error("The selected classifier is unavailable.");
      sessionOverrides = { ...sessionOverrides, classifier: { ...classifier } };
    } else {
      const { classifier: _cleared, ...remaining } = sessionOverrides;
      sessionOverrides = remaining;
    }
    withSessionState();
  }

  async function setSessionMode(mode) {
    if (!isUsageMode(mode)) throw new TypeError(`Mode must be one of: ${USAGE_MODES.join(", ")}.`);
    sessionOverrides = { ...sessionOverrides, mode };
    withSessionState();
  }

  async function restoreDefaults() {
    sessionOverrides = {};
    withSessionState();
    const preferences = await loadSystemOnePreferences(process.env);
    updateActiveTool(effectiveAccess(preferences));
  }

  function normalizeRequest(value) {
    if (!isPlainObject(value) || Object.keys(value).some((key) => !["state", "questions"].includes(key)) ||
        !isPlainObject(value.state) || !isPlainObject(value.questions) || !Object.keys(value.questions).length) {
      throw new TypeError("A native request requires object state and named questions only.");
    }
    for (const question of Object.values(value.questions)) {
      if (!isPlainObject(question) || Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key)) || typeof question.instructions !== "string") throw new TypeError("Invalid native question.");
      const criteria = question.criteria;
      const valid = question.type === "score"
        ? Array.isArray(criteria) && criteria.length > 0 && criteria.every((item) => typeof item === "string")
        : isPlainObject(criteria) && Object.keys(criteria).length > 0 && Object.values(criteria).every((item) => typeof item === "string") &&
          (question.type === "choice" || (question.type === "bool" && Object.keys(criteria).length === 2 && Object.hasOwn(criteria, "true") && Object.hasOwn(criteria, "false")));
      if (!valid) throw new TypeError("Invalid native question type or criteria.");
    }
    return { state: value.state, questions: value.questions };
  }

  async function evaluateRequest(requestValue, selection, callerSignal, ctx) {
    const request = normalizeRequest(requestValue);
    // Start before preference/model resolution and native request-time authentication.
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(callerSignal ? [callerSignal] : [])]);
    signal.throwIfAborted();
    const preferences = await loadSystemOnePreferences(process.env);
    const classifier = selection ?? sessionOverrides.classifier ?? preferences.defaultClassifier;
    signal.throwIfAborted();
    if (!isClassifierSelection(classifier)) throw new Error("No System One classifier selected. Select a provider and id.");
    const model = ctx.modelRegistry.getModelOfType("classifier", classifier.provider, classifier.id);
    if (!model) throw new Error("The selected System One classifier is unavailable.");
    const result = await ctx.modelRegistry.classify(model, request, { signal, maxRetries: 2 });
    if (result.stopReason !== "stop") {
      return Object.freeze({ classifier, result: { stopReason: result.stopReason, errorMessage: "Native classifier evaluation failed.", ...(result.usage ? { usage: result.usage } : {}) } });
    }
    return Object.freeze({ classifier, result });
  }

  async function evaluateManual(request, options = {}, ctx) {
    if (!isPlainObject(options) || Object.keys(options).some((key) => !["classifier", "signal"].includes(key)) ||
        (options.classifier !== undefined && !isClassifierSelection(options.classifier))) {
      throw new TypeError("Manual options accept only owner classifier and signal.");
    }
    return evaluateRequest(request, options.classifier, options.signal, ctx);
  }

  async function evaluateAgent(request, signal, ctx) {
    const preferences = await loadSystemOnePreferences(process.env);
    if (!effectiveAccess(preferences)) throw new Error("System One agent access is off for this session.");
    const mode = effectiveMode(preferences);
    if (mode === "custom") {
      let guidance;
      try {
        guidance = await loadCustomGuidance(process.env);
      } catch {
        throw new Error(CUSTOM_GUIDANCE_ERROR);
      }
      if (typeof guidance !== "string" || guidance.trim().length === 0) throw new Error(CUSTOM_GUIDANCE_ERROR);
    }
    return evaluateRequest(request, undefined, signal, ctx);
  }

  const api = Object.freeze({
    getStatus: status,
    setSessionAccess,
    setSessionUse,
    setSessionMode,
    restoreDefaults,
    evaluateManual,
  });

  pi.events.on(SYSTEM_ONE_API_CHANNEL, (request) => {
    if (isPlainObject(request) && typeof request.provide === "function") request.provide(api);
  });

  pi.registerTool({
    name: SYSTEM_ONE_TOOL_NAME,
    label: "System One",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Evaluate one bounded, evidence-backed Choice, Boolean, or Score judgment.",
    promptGuidelines: [FIXED_GUIDANCE],
    parameters: SYSTEM_ONE_TOOL_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await evaluateAgent(params, signal ?? ctx.signal, ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
          ...(result.result.usage ? { usage: result.result.usage } : {}),
          ...(result.result.stopReason !== "stop" ? { isError: true } : {}),
        };
      } catch (error) {
        throw new Error(safeErrorMessage(error));
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new") {
      sessionOverrides = {};
      withSessionState();
    } else {
      restoreFromBranch(ctx);
    }
    const preferences = await loadSystemOnePreferences(process.env);
    updateActiveTool(effectiveAccess(preferences));
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
    const preferences = await loadSystemOnePreferences(process.env);
    updateActiveTool(effectiveAccess(preferences));
  });

  pi.on("before_agent_start", async (event) => {
    const preferences = await loadSystemOnePreferences(process.env);
    const mode = effectiveMode(preferences);
    let customUsable = true;
    let usageGuidance = PRESET_GUIDANCE[mode];
    if (mode === "custom") {
      try {
        const custom = await loadCustomGuidance(process.env);
        customUsable = typeof custom === "string" && custom.trim().length > 0;
        usageGuidance = customUsable
          ? custom.trim()
          : `Custom guidance is missing. Do not call System One until the owner saves guidance or selects another mode (${getCustomGuidancePath(process.env)}).`;
      } catch {
        customUsable = false;
        usageGuidance = "Custom guidance is unreadable. Do not call System One until the owner saves guidance or selects another mode.";
      }
    }
    updateActiveTool(effectiveAccess(preferences) && customUsable);
    event.systemPromptOptions.sections[SYSTEM_ONE_PROMPT_SECTION] = [
      `Usage mode: ${mode}.`,
      `Mode guidance: ${usageGuidance}`,
      `Fixed boundary: ${FIXED_GUIDANCE}`,
    ].join("\n\n");
  });
}

export { FIXED_GUIDANCE, PRESET_GUIDANCE };

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeErrorMessage(error) {
  if (error?.name === "AbortError") return "System One evaluation cancelled.";
  if (error?.name === "TimeoutError") return "System One evaluation exceeded the 30-second deadline.";
  if (error instanceof TypeError || (error instanceof Error && /^(System One agent|System One evaluation|No System One classifier|The selected System One classifier)/.test(error.message))) return error.message;
  return "System One evaluation failed; check selection, native provider configuration, or cancellation.";
}

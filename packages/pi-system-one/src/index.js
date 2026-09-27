import { Type } from "typebox";
import {
  createConnectionClient,
  getDefaultCatalogPath,
  loadConnectionCatalog,
  MissingConnectionKeyError,
} from "@cartwmic/system-one-connections";
import {
  getCustomGuidancePath,
  isUsageMode,
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

const stateSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.Unknown()),
  Type.Record(Type.String(), Type.Unknown()),
]);

const questionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("choice"),
    instructions: Type.Unknown(),
    criteria: Type.Record(Type.String(), Type.Unknown(), { minProperties: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("boolean"),
    instructions: Type.Unknown(),
    criteria: Type.Optional(Type.Object({
      true: Type.Optional(Type.Unknown()),
      false: Type.Optional(Type.Unknown()),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("score"),
    instructions: Type.Unknown(),
    criteria: Type.Array(Type.Unknown(), { minItems: 1 }),
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
  "The connection and model are owner-controlled. Do not request or invent a destination, URL, connection ID, or model override.",
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
  "The connection and model are owner-selected and cannot be set here. The result is advisory and never authorizes or performs an action.",
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
        ...(overrides.connectionId === undefined ? {} : { connectionId: overrides.connectionId }),
        ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
      },
    };
    pi.appendEntry(SYSTEM_ONE_SESSION_ENTRY, data);
  }

  function decodeSessionOverrides(data) {
    if (!isPlainObject(data) || data.version !== SESSION_STATE_VERSION || !isPlainObject(data.overrides)) return undefined;
    const input = data.overrides;
    if (Object.keys(input).some((key) => !["agentAccess", "connectionId", "mode"].includes(key))) return undefined;
    if (input.agentAccess !== undefined && typeof input.agentAccess !== "boolean") return undefined;
    if (input.connectionId !== undefined && (typeof input.connectionId !== "string" || input.connectionId.length === 0)) return undefined;
    if (input.mode !== undefined && !isUsageMode(input.mode)) return undefined;
    return {
      ...(input.agentAccess === undefined ? {} : { agentAccess: input.agentAccess }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
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

  async function readCatalog() {
    return loadConnectionCatalog(getDefaultCatalogPath(process.env));
  }

  async function status() {
    const preferences = await loadSystemOnePreferences(process.env);
    let catalog;
    try {
      catalog = await readCatalog();
    } catch {
      catalog = undefined;
    }
    const activeConnectionId = sessionOverrides.connectionId ?? catalog?.default ?? null;
    return Object.freeze({
      agentAccess: effectiveAccess(preferences),
      defaultAgentAccess: preferences.agentAccess,
      sessionAgentAccess: sessionOverrides.agentAccess ?? null,
      mode: effectiveMode(preferences),
      defaultMode: preferences.defaultMode,
      sessionMode: sessionOverrides.mode ?? null,
      activeConnectionId,
      sessionConnectionId: sessionOverrides.connectionId ?? null,
      connectionAvailable: activeConnectionId !== null && catalog !== undefined && Object.hasOwn(catalog.connections, activeConnectionId),
    });
  }

  async function setSessionAccess(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Session access must be on or off.");
    sessionOverrides = { ...sessionOverrides, agentAccess: enabled };
    withSessionState();
    updateActiveTool(enabled);
  }

  async function setSessionUse(connectionId) {
    if (connectionId !== undefined && connectionId !== null) {
      if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.trim() !== connectionId) {
        throw new TypeError("Select a configured connection ID.");
      }
      const catalog = await readCatalog();
      if (!Object.hasOwn(catalog.connections, connectionId)) throw new Error("The selected connection is not configured.");
      sessionOverrides = { ...sessionOverrides, connectionId };
    } else {
      const { connectionId: _cleared, ...remaining } = sessionOverrides;
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
    if (!isPlainObject(value) || Object.keys(value).some((key) => !["state", "questions"].includes(key))) {
      throw new TypeError("A System One request must contain only state and questions; destination and action fields are not accepted.");
    }
    if (!Object.hasOwn(value, "state") || !Object.hasOwn(value, "questions") || value.state === null || value.state === undefined) {
      throw new TypeError("A System One request requires non-null state and questions.");
    }
    if (!isPlainObject(value.questions) || Object.keys(value.questions).length === 0) {
      throw new TypeError("A System One request requires at least one named question.");
    }
    return { state: value.state, questions: value.questions };
  }

  async function evaluateRequest(requestValue, connectionId, model, signal) {
    const request = normalizeRequest(requestValue);
    let connection;
    try {
      const catalog = await readCatalog();
      const overrides = {
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(model === undefined ? {} : { model }),
      };
      const connected = createConnectionClient(catalog, overrides);
      connection = connected.connection;
      const result = await connected.client.evaluate(request, signal ? { signal } : {});
      return Object.freeze({
        connectionId: connection.connectionId,
        model: result.model,
        result,
      });
    } catch (error) {
      throw new Error(safeErrorMessage(error, connection?.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined));
    }
  }

  async function evaluateManual(request, options = {}) {
    if (!isPlainObject(options) || Object.keys(options).some((key) => !["connectionId", "model", "signal"].includes(key))) {
      throw new TypeError("Manual evaluation options may contain only owner-selected connectionId, model, and signal.");
    }
    const connectionId = options.connectionId ?? sessionOverrides.connectionId;
    return evaluateRequest(request, connectionId, options.model, options.signal);
  }

  async function evaluateAgent(request, signal) {
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
    return evaluateRequest(request, sessionOverrides.connectionId, undefined, signal);
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
        const result = await evaluateAgent(params, signal ?? ctx.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
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
    updateActiveTool(effectiveAccess(preferences));
    const mode = effectiveMode(preferences);
    let usageGuidance = PRESET_GUIDANCE[mode];
    if (mode === "custom") {
      try {
        const custom = await loadCustomGuidance(process.env);
        usageGuidance = typeof custom === "string" && custom.trim()
          ? custom.trim()
          : `Custom guidance is missing. Do not call System One until the owner saves guidance or selects another mode (${getCustomGuidancePath(process.env)}).`;
      } catch {
        usageGuidance = "Custom guidance is unreadable. Do not call System One until the owner saves guidance or selects another mode.";
      }
    }
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

function safeErrorMessage(error, secret) {
  let message = error instanceof Error ? error.message : "Evaluation failed.";
  if (error instanceof MissingConnectionKeyError) message = error.message;
  if (typeof secret === "string" && secret.length > 0) message = message.split(secret).join("[redacted]");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 500);
  return message || "Evaluation failed.";
}

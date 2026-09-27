import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type UsageMode = "explicit" | "selective" | "proactive" | "custom";

export interface SystemOnePreferences {
  readonly version: 1;
  readonly agentAccess: boolean;
  readonly defaultMode: UsageMode;
}

export interface SystemOneRequest {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, unknown>>;
}

export interface ManualEvaluationOptions {
  /** Optional owner-selected connection for this call only. */
  readonly connectionId?: string;
  /** Optional owner-selected model for this call only. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface ManualEvaluation {
  readonly connectionId: string;
  readonly model: string;
  readonly result: unknown;
}

export interface SystemOneStatus {
  readonly agentAccess: boolean;
  readonly defaultAgentAccess: boolean;
  readonly sessionAgentAccess: boolean | null;
  readonly mode: UsageMode;
  readonly defaultMode: UsageMode;
  readonly sessionMode: UsageMode | null;
  readonly activeConnectionId: string | null;
  readonly sessionConnectionId: string | null;
  readonly connectionAvailable: boolean;
}

/** In-process API for an owner-facing extension such as the single pi-ui /so family. */
export interface PiSystemOneApi {
  getStatus(): Promise<SystemOneStatus>;
  setSessionAccess(enabled: boolean): Promise<void>;
  /** Omit/null to return to the catalog default; otherwise an existing catalog ID is required. */
  setSessionUse(connectionId?: string | null): Promise<void>;
  setSessionMode(mode: UsageMode): Promise<void>;
  /** Clear this session's overrides and persist the reset for reload reconstruction. */
  restoreDefaults(): Promise<void>;
  /** Direct owner invocation; does not check the agent-access gate or change session selection. */
  evaluateManual(request: SystemOneRequest, options?: ManualEvaluationOptions): Promise<ManualEvaluation>;
}

export declare const SYSTEM_ONE_API_CHANNEL: "cartwmic:pi-system-one:api";
export declare const SYSTEM_ONE_SESSION_ENTRY: "cartwmic:pi-system-one:session";
export declare const USAGE_MODES: readonly UsageMode[];
export declare function isUsageMode(value: unknown): value is UsageMode;
export declare function getSystemOnePreferencesPath(env?: Readonly<Record<string, string | undefined>>): string;
export declare function loadSystemOnePreferences(env?: Readonly<Record<string, string | undefined>>): Promise<SystemOnePreferences>;
export declare function saveSystemOnePreferences(value: SystemOnePreferences, env?: Readonly<Record<string, string | undefined>>): Promise<SystemOnePreferences>;
export declare function getCustomGuidancePath(env?: Readonly<Record<string, string | undefined>>): string;
export declare function loadCustomGuidance(env?: Readonly<Record<string, string | undefined>>): Promise<string | undefined>;
export declare function saveCustomGuidance(text: string, env?: Readonly<Record<string, string | undefined>>): Promise<void>;
export declare function getSystemOneApi(pi: Pick<ExtensionAPI, "events">): PiSystemOneApi;

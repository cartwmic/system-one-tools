import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsageMode = "explicit" | "selective" | "proactive" | "custom";

export interface ClassifierSelection { readonly provider: string; readonly id: string; }

export interface SystemOnePreferences {
  readonly version: 1;
  readonly agentAccess: boolean;
  readonly defaultMode: UsageMode;
  readonly defaultClassifier?: ClassifierSelection | null;
}

export type NativeQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "bool"; readonly instructions: string; readonly criteria: { readonly true: string; readonly false: string } }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

export interface SystemOneRequest {
  readonly state: Record<string, unknown>;
  readonly questions: Readonly<Record<string, NativeQuestion>>;
}

export interface ManualEvaluationOptions {
  readonly classifier?: ClassifierSelection;
  readonly signal?: AbortSignal;
}

export interface ManualEvaluation {
  readonly classifier: ClassifierSelection;
  readonly result: unknown;
}

export interface SystemOneStatus {
  readonly agentAccess: boolean;
  readonly defaultAgentAccess: boolean;
  readonly sessionAgentAccess: boolean | null;
  readonly mode: UsageMode;
  readonly defaultMode: UsageMode;
  readonly sessionMode: UsageMode | null;
  readonly classifier: ClassifierSelection | null;
  readonly defaultClassifier: ClassifierSelection | null;
  readonly sessionClassifier: ClassifierSelection | null;
  readonly classifierAvailable: boolean;
}

/** In-process API for an owner-facing extension such as the single pi-ui /so family. */
export interface PiSystemOneApi {
  getStatus(ctx: ExtensionContext): Promise<SystemOneStatus>;
  setSessionAccess(enabled: boolean): Promise<void>;
  /** Pass null to return to the persistent classifier default; otherwise a native provider/id is required. */
  setSessionUse(classifier: ClassifierSelection | null, ctx: ExtensionContext): Promise<void>;
  setSessionMode(mode: UsageMode): Promise<void>;
  /** Clear this session's overrides and persist the reset for reload reconstruction. */
  restoreDefaults(): Promise<void>;
  /** Direct owner invocation; does not check the agent-access gate or change session selection. */
  evaluateManual(request: SystemOneRequest, options: ManualEvaluationOptions | undefined, ctx: ExtensionContext): Promise<ManualEvaluation>;
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

export declare function isClassifierSelection(value: unknown): value is ClassifierSelection;

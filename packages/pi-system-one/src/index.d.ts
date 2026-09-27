import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export declare const SYSTEM_ONE_TOOL_NAME: "system_one";
export declare const SYSTEM_ONE_PROMPT_SECTION: "system-one-agent-usage";
export declare const SYSTEM_ONE_TOOL_PARAMETERS: TSchema;
export declare const FIXED_GUIDANCE: string;
export declare const PRESET_GUIDANCE: Readonly<Record<"explicit" | "selective" | "proactive", string>>;

export default function piSystemOneExtension(pi: ExtensionAPI): void;

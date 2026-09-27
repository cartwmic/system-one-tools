# @cartwmic/pi-system-one

Version **0.1.0**. This single Pi extension registers the structured `system_one` agent tool and the owner-facing `/so` command family. It delegates evaluation to the shared `@cartwmic/system-one-connections` client and published System One SDK. It requires Pi (tested with 0.87.1) on Node.js 22.19 or newer. This package is not published yet; publish the shared connection package first.

## Agent boundary

The tool accepts only `state` and named `questions` (Choice, Boolean, or Score). It has no connection, URL, or model parameter. It submits exactly that explicit request and never reads or automatically attaches the conversation transcript, files, or repository contents. The agent must assemble sufficient relevant evidence from user material or retrieved sources.

Use System One for an atomic judgment, not factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning. Probabilities and confidence are advisory; they do not authorize or perform an action. Compatible providers can produce different probabilities for the same evidence.

## Owner commands

```text
/so on | off                  Enable or disable agent access for this session
/so use [connection-id]       Select a configured connection, or `default`
/so mode [explicit|selective|proactive|custom]
/so status                    Show effective and default values
/so ask                       Edit and submit one manual request
/so settings                  Open the owner settings menu
/so guidance                  Edit custom usage guidance
/so reset                     Clear this session's overrides
```

`/so on`, `off`, `use`, and `mode` call the agent extension's session API; `/so status` shows effective values and their persistent/session sources. Session overrides survive `/reload` and reset in a new session. Agent access is off by default. The persistent access and prompting defaults are user-global and cannot be changed by project-local settings.

`/so ask` opens Pi's editor with an SDK-shaped JSON request containing `state` and named `questions`. It then offers an owner-selected connection and optional model override for this call only. The result appears in a terminal-only editor; neither request nor result is added to agent context. Manual evaluation works while agent access is off. Backend, credential, JSON, selection, and protocol failures are shown as errors, not results.

`/so settings` can create or edit named connections (native System One or OpenRouter Decisions), choose the catalog default, and save persistent user-global agent-access and prompting-mode preferences. Changes affect later calls/turns; active session overrides remain session-only. Custom guidance has a separate edit action. It uses Pi's editor, so **Ctrl+G** opens the configured external editor. Custom guidance changes usage direction only; the fixed evidence, data, and action boundaries remain in force. This extension does not patch Pi's built-in `/settings`.

## Preferences and custom guidance

The user-global preferences file is `<PI_CODING_AGENT_DIR>/system-one/preferences.json` (normally `~/.pi/agent/system-one/preferences.json`):

```json
{
  "version": 1,
  "agentAccess": false,
  "defaultMode": "selective"
}
```

Supported modes are **Explicit** (only when the user names System One), **Selective** (default; use for useful bounded intermediate judgments), **Proactive** (consider more eligible judgments), and **Custom** (owner usage guidance replaces preset usage direction). Fixed exclusions remain in force for every mode. Custom text is stored separately at `<PI_CODING_AGENT_DIR>/system-one/custom-guidance.md`. Missing, empty, or unreadable Custom guidance blocks agent calls with a clear error but does not block manual calls.

Connections are stored in the shared catalog at `${XDG_CONFIG_HOME:-~/.config}/system-one/connections.json`. A connection stores an explicit adapter choice when using OpenRouter, a compatible base URL, model, and optional environment-variable **name** for a runtime credential. Credential values are never requested or stored. See [`@cartwmic/system-one-connections`](../system-one-connections/README.md) for the catalog format.

## Internal session API

The extension exposes its in-process API for its own `/so` dispatcher and other integrations; it does not register duplicate command names:

```ts
import { getSystemOneApi } from "@cartwmic/pi-system-one/internal";

const systemOne = getSystemOneApi(pi);
const status = await systemOne.getStatus();
await systemOne.setSessionAccess(true);
await systemOne.setSessionUse("local"); // null/undefined restores catalog default
await systemOne.setSessionMode("selective");
await systemOne.restoreDefaults();

// Owner invocation; works even when agent access is off.
const result = await systemOne.evaluateManual({ state, questions });
```

Status includes effective/default access and mode, session overrides, the active connection ID, and whether it exists. It deliberately omits endpoint URLs, model IDs, credential environment-variable names, and credential values. Manual evaluation can take owner-only one-call `connectionId`, `model`, and `signal` options; those options do not alter session state.

## Install

Install the current Git source through its root Pi manifest:

```sh
pi install https://github.com/cartwmic/system-one-tools
```

Pi installs the repository's runtime dependencies, builds the shared connection package, and loads this one extension. The npm packages are not published yet. After publication, the intended registry install is:

```sh
pi install npm:@cartwmic/pi-system-one@0.1.0
```

Focused tests load the sole extension entry through Pi, exercise commands/settings with local scripted HTTP endpoints, and drive the real Pi TUI through `/reload`, manual ask, and Ctrl+G with a scripted external editor. Tests do not make paid live-provider calls.

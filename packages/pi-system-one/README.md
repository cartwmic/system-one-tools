# @cartwmic/pi-system-one

Version **0.1.0**. This single Pi extension registers the structured `system_one` agent tool and the owner-facing `/so` command family. The controller delegates evaluation to the current Pi native classifier registry (Pi 0.99.2+, Node.js 22.19+). Pi owns provider configuration, authentication, transport and pricing; the standalone CLI and its shared catalog remain independent. This package is not published yet.

The controller and owner dispatcher use native classifiers. Focused proofs cover a scripted native agent round-trip and a packed real-Pi PTY subset; they do not establish the complete lifecycle/provider/profile matrix or live Jev compatibility.

## Agent boundary

The tool accepts only object `state` and named `questions` (`choice`, `bool`, or `score`). Instructions and criteria are strings; choice criteria are a string map, bool criteria require `true` and `false`, and score criteria are a nonempty string array. It has no connection, URL, or model parameter. It submits exactly that explicit request and never reads or automatically attaches the conversation transcript, files, or repository contents. The agent must assemble sufficient relevant evidence from user material or retrieved sources.

Use System One for an atomic judgment, not factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning. Probabilities and confidence are advisory; they do not authorize or perform an action. Compatible providers can produce different probabilities for the same evidence.

## Owner commands

```text
/so on | off                  Enable or disable agent access for this session
/so use [provider id|default] Select a native classifier, or persistent default
/so mode [explicit|selective|proactive|custom]
/so status                    Show effective and default values
/so ask                       Edit and submit one manual request
/so settings                  Open the owner settings menu
/so guidance                  Edit custom usage guidance
/so reset                     Clear this session's overrides
```

`/so on`, `off`, `use`, and `mode` call the agent extension's session API; `/so status` shows effective values and their persistent/session sources. Session overrides survive `/reload` and reset in a new session. Agent access is off by default. The persistent access and prompting defaults are user-global and cannot be changed by project-local settings.

`/so use` without arguments offers available native classifiers as unambiguous JSON `[provider,id]` labels and a Persistent default option. For example, `/so use typesafe jev-latest` sets a session override; `/so use default` removes it. No selection is inferred from the chat model or CLI catalog.

`/so ask` opens Pi's editor with native JSON, then offers an available classifier for this call only. Editing and selection happen before submission starts the deadline; cancelling either makes no evaluation call. The terminal-only result editor discards all edits. Neither request nor result enters agent messages, prompts, transcript, control entries, or agent totals. Manual evaluation works while agent access is off or Custom guidance is missing. Native failures/aborts show no usable answers or provider error text. Reported tokens and estimated catalog cost are displayed separately; absent accounting is explicitly labelled unavailable, not zero/free.

```json
{
  "state": { "evidence": "The sample is blue." },
  "questions": {
    "color": { "type": "choice", "instructions": "Choose the supported color", "criteria": { "blue": "Blue evidence", "red": "Red evidence" } },
    "blue": { "type": "bool", "instructions": "Is it blue?", "criteria": { "true": "Blue", "false": "Not blue" } },
    "support": { "type": "score", "instructions": "Rate support", "criteria": ["Evidence supports blue"] }
  }
}
```

`/so settings` offers Set persistent classifier (including No default), Set persistent agent defaults, Edit custom guidance, and Provider/auth setup. Persistent edits leave session overrides unchanged. Configure native providers/classifier models in Pi's `models.json`; Pi owns authentication through `/login` or provider environment variables. This extension neither edits credentials nor reads the CLI connection catalog. Available menus use the current Pi registry and its authentication availability.

Guidance uses Pi's editor, so **Ctrl+G** opens the configured external editor. Custom text changes usage direction only; fixed evidence, data, and action boundaries remain in force. This extension does not patch Pi's built-in `/settings`.

## Preferences and custom guidance

The user-global preferences file is `<PI_CODING_AGENT_DIR>/system-one/preferences.json` (normally `~/.pi/agent/system-one/preferences.json`):

```json
{
  "version": 1,
  "agentAccess": false,
  "defaultMode": "selective",
  "defaultClassifier": { "provider": "typesafe", "id": "jev-latest" }
}
```

Supported modes are **Explicit** (only when the user names System One), **Selective** (default; use for useful bounded intermediate judgments), **Proactive** (consider more eligible judgments), and **Custom** (owner usage guidance replaces preset usage direction). Fixed exclusions remain in force for every mode. Custom text is stored separately at `<PI_CODING_AGENT_DIR>/system-one/custom-guidance.md`. Missing, empty, or unreadable Custom guidance blocks agent calls with a clear error but does not block manual calls.

Pi does not read or migrate `connections.json`. An unset classifier fails clearly, without using the chat model or selecting an arbitrary fallback.

## Internal session API

The extension exposes its in-process API for its own `/so` dispatcher and other integrations; it does not register duplicate command names:

```ts
import { getSystemOneApi } from "@cartwmic/pi-system-one/internal";

const systemOne = getSystemOneApi(pi);
const status = await systemOne.getStatus(ctx);
await systemOne.setSessionAccess(true);
await systemOne.setSessionUse({ provider: "typesafe", id: "jev-latest" }, ctx); // null restores persistent default
await systemOne.setSessionMode("selective");
await systemOne.restoreDefaults();

// Owner invocation; works even when agent access is off.
const result = await systemOne.evaluateManual({ state, questions }, {
  classifier: { provider: "typesafe", id: "jev-latest" }, // optional, this call only
  signal: ownerAbortController.signal, // optional cancellation
}, ctx);
```

Status includes effective/default/session access, mode and classifier `{provider,id}`, plus `classifierAvailable` from Pi's available native catalog. Selection is independent of the chat model. Every registry-using call receives the current `ctx`; no session context is captured. Manual options accept only an owner-only one-call `classifier` and `signal`, without changing defaults or session selection.

Evaluations return `{classifier,result}`. Failed native `error`/`aborted` results contain no usable answers, but retain reported usage. Agent tool results forward native usage at the top level into Pi totals, including billed failures. Missing usage or pricing must not be represented as a free call. Manual accounting stays separate.

One shared 30-second signal starts before classifier resolution/authentication and covers all native preparation/readout requests and retry waits. `maxRetries: 2` allows at most three attempts per native HTTP operation; multi-request algorithms are allowed, with no outer retries, fallback or deadline reset. Owner editing/selection happens outside that budget.

`/so off` governs only the retained `system_one` tool, not direct native codemode classification. Manual controller calls remain available while agent access is off. Branch entries contain controls only, never manual requests/results. Reload/resume/tree restore the active branch; new sessions clear overrides and reset restores persistent defaults.

## Install

Install the current Git source through its root Pi manifest:

```sh
pi install https://github.com/cartwmic/system-one-tools
```

Pi installs the repository's runtime dependencies, builds the shared connection package, and loads this one extension. The npm packages are not published yet. After publication, the intended registry install is:

```sh
pi install npm:@cartwmic/pi-system-one@0.1.0
```

Focused commands from the repository root (Pi 0.99.2+, Node 22.19+, Python 3 for PTY):

```sh
node --test --test-name-pattern='native classifier agent contract|native caller bounds' packages/pi-system-one/test/pi-system-one.test.mjs
node --test --test-name-pattern='a real Pi TUI owner journey' packages/pi-system-one/test/pi-system-one-ui.test.mjs
```

The actual agent proof validates native Choice/bool/score, authentication and request bodies at `/api/v1/systemone`, billed failures and actual session accounting. The native bounds journey also completes cold llama-cpp's multiple preparation/readout operations, per-operation transient retries, shared multistage deadlines and agent/manual cancellation during work and retry waits.

Packed PTY journeys exercise default/session/one-call selection, reset, reload, nonempty resume, new sessions, all prompting modes and unusable Custom guidance. Manual Bool/Score and missing accounting labels are displayed; actual session totals stay unchanged. Editing beyond 30 seconds precedes submission, and early editor/picker cancellation makes no request. Independent input/output markers are absent from the next completed agent context and saved sessions. Test-only transport guards pin exact fixture URLs before discovery and retain the SDK's fetch/Headers pairing. These helpers are not product transport wrappers.

The dispatcher test remains intermediate controller/UI evidence, not a substitute for those public journeys. `scripts/test-native-profiles.mjs` separately composes relevant source personal/work settings and native callers without applying them. `scripts/prove-live-jev.mjs --validate-only` tests live-proof admission and budget controls offline. Actual live execution is separately opt-in and requires successful stable-tree scripted receipts. No live compatibility or calibration claim follows from scripted validation.

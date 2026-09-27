# System One tools

A small npm workspace with three separately installable packages:

- `@cartwmic/system-one-connections` — the shared user-level connection catalog and SDK client.
- `@cartwmic/system-one-cli` — the standalone `system-one` JSON command.
- `@cartwmic/pi-system-one` — one Pi extension containing the `system_one` agent tool and the owner-facing `/so` commands/settings UI.

All packages are version **0.1.0** and are not published. This repository does not publish or install packages into a live Pi configuration, edit dotfiles, or call a paid provider.

## Requirements

- Node.js 20+ for the shared package and CLI.
- Pi 0.87.1 was used for validation; the Pi extension requires Node.js 22.19+.
- `npm run test:package` is run on macOS with Docker available. It checks independent macOS CLI and Pi package consumers and a Node 20 Linux CLI consumer in Docker.
- `npm run test:tui` requires Pi and Python 3. It drives Pi's real TUI in an isolated PTY. This is not a tmux-backed scenario; it does not claim tmux-specific coverage.

## Build and scripted proof

```sh
npm install
npm run check
npm run test:journey
npm run test:tui
npm run test:package
```

The exact root scripts are:

- `check` — builds the three workspaces and runs their offline tests.
- `test:journey` — installs local package tarballs in separate CLI and Pi consumers. In one temporary user home, it saves a connection and catalog default through the installed extension's real `/so settings` command, then evaluates through the CLI and a real Pi agent turn. Both must reach the same scripted HTTP endpoint, despite a conflicting project-local Pi setting.
- `test:tui` — drives the real Pi TUI through `/so`, `/reload`, manual ask, and Ctrl+G with a scripted external editor and local backend.
- `test:package` — builds and packs the shared package, then installs it with exactly one driver package in each clean consumer: shared+CLI and shared+Pi. It verifies resolution stays inside each consumer, exercises real CLI and Pi paths against dummy HTTP services, tests failures, and runs the Node 20 Linux CLI consumer in Docker. Run this matrix on macOS.

All test backends are scripted and local. No test needs a real credential or makes a live provider call. Scripted protocol and package proof do not establish authenticated TypeSafe/OpenRouter compatibility or semantic calibration of a local model. No live backend was exercised.

## Shared connection catalog

The CLI and Pi use the same catalog at `${XDG_CONFIG_HOME:-~/.config}/system-one/connections.json`. The catalog stores endpoint configuration, a model ID, and optionally the **name** of an environment variable—not its secret value. A non-secret local example:

```json
{
  "version": 1,
  "default": "local",
  "connections": {
    "local": {
      "baseURL": "http://127.0.0.1:8317/v1",
      "model": "local-system-one"
    }
  }
}
```

Set a configured credential variable in the caller's runtime environment. A connection without `apiKeyEnv` makes unauthenticated requests. The shared package rejects inline keys and URLs containing credentials. The SDK appends its System One route to the configured base URL; each service must implement the compatible System One state-plus-questions protocol.

Provider-specific endpoint examples are configuration data in [`packages/system-one-connections/examples/connections.example.json`](packages/system-one-connections/examples/connections.example.json). See the [connection package README](packages/system-one-connections/README.md) for catalog schema and API details.

## CLI

After publication, install the CLI; its versioned shared-package dependency is installed with it:

```sh
npm install --global @cartwmic/system-one-cli@0.1.0
system-one --help
cat request.json | system-one
system-one --connection local --model one-call-model --file request.json
```

The command reads one JSON request with `state` and named Choice, Boolean, or Score `questions`. `--connection` selects a configured connection and `--model` overrides its model for this call only; neither changes saved settings. On success, stdout contains one SDK-shaped JSON result with `connectionId`. On failure, stdout is empty, stderr contains one sanitized JSON error, and the process exits nonzero. It makes one attempt and never falls back. See the [CLI README](packages/system-one-cli/README.md) for request/result examples and error codes.

Use a decision model only for an atomic, specific judgment over sufficient relevant evidence. Do not use it for factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning. Probabilities and confidence are advisory, not guarantees or permission to act. Send only the state and questions needed for the call.

## Pi

After publication, install the single Pi extension:

```sh
pi install npm:@cartwmic/pi-system-one@0.1.0
```

Agent access is off by default. `/so settings` can save user-global agent-access and prompting-mode defaults and edit named connections and the catalog default. Preferences live at `<PI_CODING_AGENT_DIR>/system-one/preferences.json` (normally `~/.pi/agent/system-one/preferences.json`). Project-local Pi settings cannot enable the agent tool or redirect its connection. `/so on|off` changes access for the current session; `/so use` selects the owner's session connection; `/so status` shows effective settings.

The modes are Explicit, Selective (default), Proactive, and Custom. They guide when to use the tool; none changes its fixed evidence, data, or action limits. The agent can submit only explicit `state` and `questions`; it cannot choose a connection/model or automatically attach files, repository content, or conversation history. `/so ask` remains available while agent access is off and displays its result in the terminal without adding it to agent context. `/so guidance` edits Custom mode text; Ctrl+G opens Pi's configured external editor.

Each call makes one attempt. Endpoint, model, limits, possible provider costs, and local-model calibration vary by connection. Proactive use can make multiple billable calls over time; results remain advisory. See the [Pi package README](packages/pi-system-one/README.md) for commands, preference behavior, and failure handling.

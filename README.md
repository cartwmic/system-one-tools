# System One tools

## Purpose

This repository has a `system-one` JSON command and one Pi extension for Choice, Boolean, and Score judgments over supplied evidence. Both use the published `@system-one-ai` SDK through a shared connection catalog:

- [`@cartwmic/system-one-connections`](packages/system-one-connections/README.md) reads named endpoints, models, and credential environment-variable names.
- [`@cartwmic/system-one-cli`](packages/system-one-cli/README.md) provides the standalone command for scripts and other harnesses.
- [`@cartwmic/pi-system-one`](packages/pi-system-one/README.md) provides the `system_one` agent tool and owner-facing `/so` commands.

Use a compatible System One HTTP service for an atomic question with enough relevant evidence. Probabilities are advisory; they do not authorize an action. Do not use this tool for factual lookup, exact calculations, open-ended generation, or substantial reasoning. The packages are at version 0.1.0 and have not been published to npm. This public source has no LICENSE file; each package manifest declares `UNLICENSED`. Ask the owner for permission before reusing or redistributing the code.

## Quick Start

For the full workspace, use Node.js 22.19+ and npm on macOS or Linux. The CLI and shared package support Node.js 20+. Pi is needed for the Pi tests; [install Pi separately](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started). The extension was tested with Pi 0.87.1. Other Pi versions have not been verified here. This Quick Start exercises the CLI from source. The Pi package has no npm registry install yet; `npm run test:tui` loads a packed local copy in an isolated Pi session with a scripted backend. Your regular Pi configuration stays unchanged.

```sh
git clone https://github.com/cartwmic/system-one-tools.git
cd system-one-tools
npm ci
npm run build
node packages/system-one-cli/dist/cli.js --help
```

These commands build the checkout and show CLI help. To open the Pi extension from this checkout, run from the repository root:

```sh
pi --no-session --no-extensions --extension ./packages/pi-system-one/src/index.js
```

Enter `/so status` in Pi. This one-off session does not install a package or save a conversation; `--no-extensions` disables other extension discovery. For an isolated scripted Pi journey, use `npm run test:tui` under [Validation](#validation). Building does not configure a decision endpoint. This checkout ships no service or model list. Before evaluating, obtain a compatible endpoint, model ID, and any required credential. Existing connections use the SDK [native adapter](https://github.com/ziyu/system-one-sdk/tree/main/packages/adapter-system-one), which sends `{model,state,questions}` to `<baseURL>/systemone`. An explicit `adapter: "openrouter"` connection uses [OpenRouter Decisions](https://openrouter.ai/blog/insights/what-is-jev/) at `/api/alpha/decisions`. Both return typed answers; the [scripted HTTP fixture](packages/system-one-cli/test/cli.test.mjs) shows the wire shape. A generic chat-completions endpoint cannot serve either route. The local address and model below are illustrative.

## Usage

The CLI and Pi read `${XDG_CONFIG_HOME:-$HOME/.config}/system-one/connections.json`. For a local service listening on port 8317, create a catalog with a default:

```sh
catalog="${XDG_CONFIG_HOME:-$HOME/.config}/system-one/connections.json"
mkdir -p "$(dirname "$catalog")"
( set -C; cat > "$catalog" <<'JSON'
{"version":1,"default":"local","connections":{"local":{"baseURL":"http://127.0.0.1:8317/v1","model":"local-system-one"}}}
JSON
)
```

This example refuses to replace an existing catalog. If you already have one, edit it to add the named connection and choose its default deliberately. For OpenRouter Decisions, use this catalog as a starting point, or add its connection to your existing catalog. Select it with `--connection openrouter` or `/so use openrouter`:

```json
{
  "version": 1,
  "default": "openrouter",
  "connections": {
    "openrouter": {
      "adapter": "openrouter",
      "baseURL": "https://openrouter.ai/api/v1",
      "model": "~typesafe/jev-latest",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

The OpenRouter adapter maps `/api/v1` to `/api/alpha/decisions`. The native adapter appends `/systemone` to its base URL. `apiKeyEnv` stores the **name** of an environment variable; export its value in the caller's environment. The catalog must not contain the key value. [Connection examples](packages/system-one-connections/examples/connections.example.json) show both adapters.

With that local service running, submit one SDK-shaped request:

```sh
printf '%s\n' '{"state":{"evidence":"A required check failed."},"questions":{"release":{"type":"choice","instructions":"What does the evidence support?","criteria":{"wait":"Wait","proceed":"Proceed"}}}}' | node packages/system-one-cli/dist/cli.js
```

Success writes one JSON value with `connectionId` to stdout. For the Choice request above, read `answers.release.choice` (such as `wait` or `proceed`); see the [CLI JSON contract](packages/system-one-cli/README.md#json-contract) for other normalized fields. Failure exits nonzero, leaves stdout empty, and writes a sanitized JSON error to stderr. Calls make one attempt with no connection or model fallback. `--connection` and `--model` select one-call overrides; they do not edit the catalog.

The Pi extension uses the same catalog. Agent access starts off unless user-global preferences turn it on. `/so settings` edits connections and defaults, `/so ask` submits a manual request while agent access is off, and `/so on|off`, `/so use`, and `/so mode` change the current session. See the [Pi command reference](packages/pi-system-one/README.md) for the full command list and session behavior. The Quick Start loads the extension from source for a one-off session. The npm install command in its package README applies after publication.

## Validation

Run the full scripted checks with Node.js 22.19+, Pi, and Python 3 installed. The package matrix also needs macOS with Docker running:

```sh
npm run check
npm run test:journey
npm run test:tui
npm run test:package
```

`check` builds the three packages and runs offline tests. `test:journey` installs local tarballs in separate CLI and Pi consumers, saves a catalog entry through `/so settings`, then checks that the CLI and a real Pi turn use the same scripted endpoint. `test:tui` drives Pi through `/reload`, `/new`, manual use, and Ctrl+G in an isolated PTY. Inspect its TAP output for a completed test with zero skips. `test:package` checks independent macOS consumers and a Linux Node 20 CLI consumer in Docker; it does not run Pi under Node 20.

The automated suites use scripted backends. On 2026-09-27, bounded OpenRouter Decisions calls completed through the CLI, isolated Pi `/so ask`, and Pi's `system_one` tool using `openrouter/openai/gpt-4.1-mini`. A scripted Pi model also exercised the tool path against the live decision endpoint. The calls used the Jev latest alias. This is point-in-time evidence. Direct TypeSafe authentication, other model support, and local-model calibration remain unverified. Live smoke tests may incur charges. Repository procedure and proof boundaries for contributors are in [AGENTS.md](AGENTS.md).

## Troubleshooting

- `CONNECTION_CATALOG_ERROR`: the catalog file is missing or invalid. Check its path and JSON first; `--connection` cannot repair a missing catalog.
- `CONNECTION_SELECTION_ERROR`: the catalog has no default or the selected name is absent. Set `default`, or pass `--connection` with a configured name. Pi users with the extension loaded can use `/so settings`.
- `MISSING_CREDENTIAL`: export the variable named by the selected connection's `apiKeyEnv` in the process running the CLI or Pi. Keep the value out of the catalog.
- `TIMEOUT`: the pinned SDK 0.6.0 defaults to a 10-second evaluation deadline. The CLI accepts `--timeout-ms` for slower services. The current Pi tool and `/so ask` do not expose a timeout override; check the service's latency.
- `NETWORK_ERROR`: the selected service cannot be reached. Start it and check the catalog's host and port.
- `PROVIDER_REJECTED`: the service returned an HTTP error. Check the stderr status, server logs, route, model, and required credential environment variable.
- `MALFORMED_RESPONSE`: the endpoint returned data the selected adapter could not decode. Compare its JSON `model` and typed `answers` with the [`providerResponse` fixture](packages/system-one-cli/test/cli.test.mjs), then inspect the server logs. The published `@system-one-ai/adapter-system-one` and `@system-one-ai/adapter-openrouter` define their respective protocols.
- `/so` is unknown: Pi has not loaded the extension. From the repository root, start a new session with `pi --no-session --no-extensions --extension ./packages/pi-system-one/src/index.js`, then run `/so status`.
- `/so status` works and `system_one` is absent: agent access defaults off. Run `/so on` for this session. Project-local Pi settings cannot enable it.
- `test:tui` skips its selected TUI case: install Python 3 and rerun; the expected result is one test passed with zero skips. Pi must also be installed. The TUI proof uses a PTY, with no tmux-specific coverage.
- `test:package` cannot start its matrix: run it on macOS with Docker available.

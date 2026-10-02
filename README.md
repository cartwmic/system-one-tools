# System One tools

## Purpose

This repository has a `system-one` JSON command and one Pi extension for Choice, Boolean, and Score judgments over supplied evidence. The CLI uses the published `@system-one-ai` SDK and a connection catalog. Pi uses its native classifier registry, provider authentication, and adapters independently:

- [`@cartwmic/system-one-connections`](packages/system-one-connections/README.md) reads named endpoints, models, and credential environment-variable names.
- [`@cartwmic/system-one-cli`](packages/system-one-cli/README.md) provides the standalone command for scripts and other harnesses.
- [`@cartwmic/pi-system-one`](packages/pi-system-one/README.md) provides the `system_one` agent tool and owner-facing `/so` commands.

Use a compatible System One HTTP service for an atomic question with enough relevant evidence. Probabilities are advisory; they do not authorize an action. Do not use this tool for factual lookup, exact calculations, open-ended generation, or substantial reasoning. The packages are at version 0.1.0 and have not been published to npm. This public source has no LICENSE file; each package manifest declares `UNLICENSED`. Ask the owner for permission before reusing or redistributing the code.

## Quick Start

For the full workspace, use Node.js 22.19+ and npm on macOS or Linux. The CLI and shared package support Node.js 20+. Pi is needed for the Pi tests; [install Pi separately](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started). The native extension requires Pi 0.99.2+ and Node.js 22.19+. Focused scripted proofs use Pi 0.99.2. This Quick Start exercises the CLI from source. The Pi package has no npm registry install yet; `npm run test:tui` loads a packed local copy in an isolated Pi session with a scripted backend. Your regular Pi configuration stays unchanged.

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

Enter `/so status` in Pi. This one-off session does not install a package or save a conversation; `--no-extensions` disables other extension discovery. For a persistent Git installation, use:

```sh
pi install https://github.com/cartwmic/system-one-tools
```

Pi clones the repository and loads the single nested extension declared in the root Pi manifest. The existing root prepare hook still builds the shared package for CLI/SDK consumers; the Pi extension has no shared-package dependency. The packages are not published to npm. For an isolated scripted Pi journey, use `npm run test:tui` under [Validation](#validation). Building does not configure a decision endpoint. This checkout ships no service or model list. Before evaluating, obtain a compatible endpoint, model ID, and any required credential. Existing connections use the SDK [native adapter](https://github.com/ziyu/system-one-sdk/tree/main/packages/adapter-system-one), which sends `{model,state,questions}` to `<baseURL>/systemone`. An explicit `adapter: "openrouter"` connection uses [OpenRouter Decisions](https://openrouter.ai/blog/insights/what-is-jev/) at `/api/alpha/decisions`. Both return typed answers; the [scripted HTTP fixture](packages/system-one-cli/test/cli.test.mjs) shows the wire shape. A generic chat-completions endpoint cannot serve either route. The local address and model below are illustrative.

## Usage

The CLI reads `${XDG_CONFIG_HOME:-$HOME/.config}/system-one/connections.json`. For a local service listening on port 8317, create a catalog with a default:

```sh
catalog="${XDG_CONFIG_HOME:-$HOME/.config}/system-one/connections.json"
mkdir -p "$(dirname "$catalog")"
( set -C; cat > "$catalog" <<'JSON'
{"version":1,"default":"local","connections":{"local":{"baseURL":"http://127.0.0.1:8317/v1","model":"local-system-one"}}}
JSON
)
```

This example refuses to replace an existing catalog. If you already have one, edit it to add the named connection and choose its default deliberately. For OpenRouter Decisions, use this catalog as a starting point, or add its connection to your existing catalog. Select it in the CLI with `--connection openrouter`:

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

Pi does **not** read or edit that catalog. Configure a native classifier provider/model in Pi's `models.json` and use Pi authentication (`/login` or a supported provider environment reference). Select its provider and model ID with `/so use PROVIDER MODEL`; `/so settings` can save a persistent classifier default. The chat model remains independently selected in Pi. Native `typesafe-system-one` OpenRouter calls use `/api/v1/systemone`, not the CLI SDK's `/api/alpha/decisions`. Native llama-cpp uses its tokenize/template/completion operations.

Agent access defaults off. `/so on|off`, `/so mode`, `/so reset`, `/so status`, and `/so guidance` retain owner controls; `/so ask` is a private, terminal-only, one-call native evaluation even while agent access is off. It does not add manual input/output or usage to the agent conversation/totals. The native evaluation has one 30-second deadline including resolution, transport, retry waits and response bodies, with at most two retries per HTTP operation, no extension-level retry/fallback, and no deadline reset. Failed results have no usable answers; reported billed agent errors still contribute usage. See the [Pi reference](packages/pi-system-one/README.md) for setup and request shapes.

## Validation

Run the full scripted checks with Node.js 22.19+, Pi, and Python 3 installed. The package matrix also needs macOS with Docker running:

```sh
npm run check
npm run test:journey
npm run test:tui
npm run test:package
```

`check` builds the three packages and runs offline tests. `test:journey` installs local tarballs in separate CLI and Pi-only consumers, preserves CLI catalog/default bytes, and completes native Pi tool turns both with and without that catalog. Scripted children clear inherited provider credentials and preload an exact fixture-URL guard before discovery.

`test:tui` runs actual packed-consumer PTY journeys for defaults/session/one-call selection, reset, reload, nonempty resume, new sessions, prompting modes and unusable Custom guidance. Manual Choice/bool/score, accounting labels, unchanged actual session totals, early cancellation and subsequent-context/saved-session privacy are checked. Inspect TAP for every selected journey completing with zero skips. Native caller tests also exercise cold llama-cpp's multiple operations, per-operation retries, shared deadlines and cancellation during work/retry waits. `test:package` checks independent macOS consumers and a Linux Node 20 CLI consumer in Docker; it does not run Pi under Node 20.

Source-profile composition and the opt-in live executor have separate commands:

```sh
node scripts/test-native-profiles.mjs --dotfiles-source "$DOTFILES_SOURCE" --profile personal
node scripts/test-native-profiles.mjs --dotfiles-source "$DOTFILES_SOURCE" --profile axon-work-computer
node scripts/prove-live-jev.mjs --validate-only
```

Set `DOTFILES_SOURCE` to the approved chezmoi source worktree. Profile checks render isolated, hook-free configuration and drive relevant native Pi callers; they do not apply settings or install unrelated packages. The offline live-executor validator makes no provider request. Actual live mode requires separate owner approval plus successful identity-bound scripted receipts; it is never part of `check`. Its six toy Jev evaluations have a maximum of 18 transport requests and stop the entire matrix on the first terminal failure. Scripted checks alone do not establish live-provider compatibility or calibration.

The automated suites use scripted backends. On 2026-09-27, bounded OpenRouter Decisions calls completed through the CLI, isolated Pi `/so ask`, and Pi's `system_one` tool using `openrouter/openai/gpt-4.1-mini`. A scripted Pi model also exercised the tool path against the live decision endpoint. The calls used the Jev latest alias. This is dated SDK-route evidence, not proof of the current native OpenRouter Jev caller. Direct TypeSafe authentication, other model support, and local-model calibration remain unverified. Live smoke tests may incur charges. Repository procedure and proof boundaries for contributors are in [AGENTS.md](AGENTS.md).

## Troubleshooting

- `CONNECTION_CATALOG_ERROR`: the catalog file is missing or invalid. Check its path and JSON first; `--connection` cannot repair a missing catalog.
- `CONNECTION_SELECTION_ERROR`: the catalog has no default or the selected name is absent. Set `default`, or pass `--connection` with a configured name. Pi classifier selection is independent of this CLI error.
- `MISSING_CREDENTIAL`: export the variable named by the selected connection's `apiKeyEnv` in the process running the CLI. Pi uses native provider authentication. Keep the value out of the catalog.
- `TIMEOUT`: the pinned SDK 0.6.0 defaults to a 10-second evaluation deadline. The CLI accepts `--timeout-ms` for slower services. The native Pi tool and `/so ask` instead use a fixed 30-second combined deadline; neither exposes an override.
- `NETWORK_ERROR`: the selected service cannot be reached. Start it and check the catalog's host and port.
- `PROVIDER_REJECTED`: the service returned an HTTP error. Check the stderr status, server logs, route, model, and required credential environment variable.
- `MALFORMED_RESPONSE`: the endpoint returned data the selected adapter could not decode. Compare its JSON `model` and typed `answers` with the [`providerResponse` fixture](packages/system-one-cli/test/cli.test.mjs), then inspect the server logs. The published `@system-one-ai/adapter-system-one` and `@system-one-ai/adapter-openrouter` define their respective protocols.
- `/so` is unknown: Pi has not loaded the extension. From the repository root, start a new session with `pi --no-session --no-extensions --extension ./packages/pi-system-one/src/index.js`, then run `/so status`.
- `/so status` works and `system_one` is absent: agent access defaults off. Run `/so on` for this session. Project-local Pi settings cannot enable it.
- `test:tui` skips its selected TUI case: install Python 3 and rerun; the expected result is one test passed with zero skips. Pi must also be installed. The TUI proof uses a PTY, with no tmux-specific coverage.
- `test:package` cannot start its matrix: run it on macOS with Docker available.

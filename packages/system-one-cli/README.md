# @cartwmic/system-one-cli

Version **0.1.0**. This package provides the standalone `system-one` JSON command. It runs on Node.js 20+ and depends on the separately versioned `@cartwmic/system-one-connections` package; it does not require Pi or paths from this source checkout. Neither package is published yet; publish the shared package before the CLI when a release is authorized.

## Install and run

After installing this package and `@cartwmic/system-one-connections`, the binary is `system-one`:

```sh
system-one --help
system-one --connection local --file request.json
cat request.json | system-one --connection local --model temporary-model
```

Without `--file`, the command reads one complete JSON value from stdin. The selected connection comes from `--connection ID`, or from the catalog's `default`. `--model MODEL` and `--connection ID` are owner-controlled overrides for this call only; neither edits the saved catalog. `--timeout-ms MS` sets a positive total evaluation timeout. Runtime credentials are read from the configured environment variable named by the selected connection's `apiKeyEnv`.

The catalog path is shared with other System One callers: `~/.config/system-one/connections.json`, or `$XDG_CONFIG_HOME/system-one/connections.json` when `XDG_CONFIG_HOME` is set. See [`@cartwmic/system-one-connections`](../system-one-connections/README.md) for the catalog schema and backend URL examples. A missing default, invalid selection, or missing required credential fails without trying another connection.

## JSON contract

A request is one object using the SDK request fields, except that model selection must use the CLI flag:

```json
{
  "state": { "evidence": "The caller supplies relevant evidence." },
  "questions": {
    "choice": {
      "type": "choice",
      "instructions": "Which option is better supported?",
      "criteria": { "first": "First option", "second": "Second option" }
    },
    "boolean": {
      "type": "boolean",
      "instructions": "Is the claim supported?"
    },
    "score": {
      "type": "score",
      "instructions": "Rate the evidence.",
      "criteria": ["low", "medium", "high"]
    }
  }
}
```

The native adapter rejects nonempty `providerOptions` with `UNSUPPORTED_REQUEST`. Connections with `adapter: "openrouter"` accept supported options under `providerOptions.openrouter` (for example, `session_id` or `user`); the SDK rejects unsupported fields. Choice, Boolean, and Score questions keep the SDK's public shape; the selected adapter handles the wire protocol. The command makes one evaluation attempt and never retries or falls back to another connection or model.

A successful invocation exits 0 and writes exactly one JSON object followed by a newline to stdout. It returns the normalized SDK result—including the resolved `model`, typed `answers`, any supplied probabilities, confidence, usage, warnings, metadata, and response details—and adds the selected `connectionId` at the top level. The SDK may add empty usage or warning containers and response-attempt metadata even when the provider omits them. The CLI does not invent answer probabilities or confidence.

A failed invocation exits nonzero, leaves stdout empty, and writes exactly one sanitized JSON object to stderr:

```json
{"error":{"code":"TIMEOUT","message":"The evaluation timed out."}}
```

Common stable error codes include `INVALID_JSON`, `INVALID_INPUT`, `CONNECTION_CATALOG_ERROR`, `CONNECTION_SELECTION_ERROR`, `MISSING_CREDENTIAL`, `TIMEOUT`, `CANCELLED`, `MALFORMED_RESPONSE`, `PROVIDER_REJECTED`, and `NETWORK_ERROR`. Error messages do not include provider bodies or credential values. Provider-echoed credential text in result strings or field names is redacted before stdout is written. Numeric result values remain numbers. Ctrl-C and SIGTERM cancel an active call and produce an explicit `CANCELLED` error; there is no success-shaped partial answer.

## When to use a decision model

Use this for atomic, specific judgments over sufficient relevant supplied evidence. Do not use it for factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning. Send only the state and questions needed for the call. Probabilities and confidence are model outputs, not guarantees or permission to act.

## Development

From the workspace root:

```sh
npm run build
npm test
```

The focused tests spawn the built command as a child process and use scripted HTTP endpoints; they make no paid live-provider calls. The package has a real `system-one` bin and a versioned shared-package dependency. This repository change does not publish it.

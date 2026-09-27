# @cartwmic/system-one-connections

Version **0.1.0**. Shared user connection catalog and SDK client composition for the System One CLI and Pi callers. This package owns configuration and SDK wiring only; it contains no CLI or Pi dependency and does not implement a second decision protocol.

## Catalog

By default, callers read `~/.config/system-one/connections.json`. `XDG_CONFIG_HOME` overrides `~/.config`; the catalog is stored at `$XDG_CONFIG_HOME/system-one/connections.json`. The catalog can omit `default` when callers must select a connection explicitly.

```json
{
  "version": 1,
  "default": "typesafe",
  "connections": {
    "typesafe": {
      "baseURL": "https://api.typesafe.ai/v1",
      "model": "jev-latest",
      "apiKeyEnv": "TYPESAFE_API_KEY"
    },
    "openrouter": {
      "adapter": "openrouter",
      "baseURL": "https://openrouter.ai/api/v1",
      "model": "~typesafe/jev-latest",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "local": {
      "baseURL": "http://127.0.0.1:8317/v1",
      "model": "local-system-one"
    }
  }
}
```

Connections without `adapter` use the native System One adapter and append `/systemone` to their base URL. `adapter: "openrouter"` selects the SDK's OpenRouter Decisions adapter, which maps `/api/v1` to `/api/alpha/decisions`. Adapter selection is explicit; the hostname does not change it. A generic chat-completions endpoint cannot serve these typed-decision routes. A connection without `apiKeyEnv` is unauthenticated. `apiKeyEnv` stores only an environment-variable **name**; the key value is resolved from the runtime environment immediately before the request and is never read from or written to the catalog. Unknown fields (including inline credential fields), URLs with embedded credentials, and malformed catalogs are rejected.

Copy [`examples/connections.example.json`](./examples/connections.example.json) as a starting point and replace model IDs as needed. Set credential variables in the caller's environment; do not put their values in this file.

## API

```ts
import {
  createConnectionClient,
  loadConnectionCatalog,
} from "@cartwmic/system-one-connections";

const catalog = await loadConnectionCatalog();
const { connection, client } = createConnectionClient(catalog, {
  connectionId: "local",       // optional, owner-selected for this call
  model: "temporary-model-id", // optional, owner-selected for this call
});

const result = await client.evaluate({
  state: { evidence: "The caller supplies only relevant evidence." },
  questions: {
    choice: {
      type: "choice",
      instructions: "Which option is better supported?",
      criteria: { first: "First option", second: "Second option" },
    },
    boolean: {
      type: "boolean",
      instructions: "Is the claim supported?",
    },
    score: {
      type: "score",
      instructions: "Rate the evidence.",
      criteria: ["low", "medium", "high"],
    },
  },
});

console.log(connection.connectionId, result.model, result.answers);
```

`connection` is an immutable snapshot. Editing the catalog later does not redirect an existing client; load it again and construct a new client for the next call. The owner-only `connectionId` and `model` overrides do not change the saved default. Model selection belongs in these overrides, not the SDK-shaped request. Catalogs with no default require an explicit `connectionId`.

The wrapper uses the published `@system-one-ai/core@0.6.0`, `@system-one-ai/adapter-system-one@0.6.0`, `@system-one-ai/adapter-openrouter@0.6.0`, and `@system-one-ai/transport-fetch@0.6.0`. It disables SDK retries at construction and forces `maxRetries: 0` per evaluation. Timeouts and abort signals remain available through the second `evaluate` argument. Provider rejection, transport failure, and malformed answers remain errors; there is no fallback to another connection or model.

## Catalog file API

- `getDefaultCatalogPath(env?)` returns the shared user-level path.
- `loadConnectionCatalog(path?)` reads and validates version 1.
- `validateConnectionCatalog(value)` validates an in-memory value and returns a frozen normalized snapshot.
- `writeConnectionCatalog(value, path?)` validates before writing, then atomically replaces the file with mode `0600` (parent directories are created with mode `0700`).
- `updateConnectionCatalog(update, path?)` gives the callback a frozen current catalog and atomically writes its validated replacement. Return the replacement catalog from the callback.

The exported `ConnectionCatalog`, `Connection`, snapshot, override, and client types are available to TypeScript consumers. `ConnectionCatalogError`, `ConnectionSelectionError`, and `MissingConnectionKeyError` distinguish configuration, selection, and missing-runtime-key failures. Error messages never include key values.

This package is independently packable from the npm workspace. It is not published by this change.

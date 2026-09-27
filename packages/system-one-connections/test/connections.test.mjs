import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConnectionCatalogError,
  ConnectionSelectionError,
  MissingConnectionKeyError,
  createConnectionClient,
  getDefaultCatalogPath,
  loadConnectionCatalog,
  resolveConnection,
  updateConnectionCatalog,
  validateConnectionCatalog,
  writeConnectionCatalog,
} from "../dist/index.js";

const syntheticKey = "synthetic-never-store-this-key";
const request = {
  state: { evidence: "The caller supplies the evidence." },
  questions: {
    choice: {
      type: "choice",
      instructions: "Which option is better supported?",
      criteria: { yes: "Choose yes", no: "Choose no" },
    },
    boolean: {
      type: "boolean",
      instructions: "Is the claim supported?",
      criteria: { true: "Supported", false: "Not supported" },
    },
    score: {
      type: "score",
      instructions: "Rate the evidence.",
      criteria: ["low", "medium", "high"],
    },
  },
};

const scriptedResponse = {
  model: "resolved-by-script",
  answers: {
    choice: {
      type: "choice",
      choice: "yes",
      probabilities: { yes: 0.7, no: 0.3 },
      confidence: 0.91,
    },
    boolean: { type: "noul", noul: 0.64 },
    score: {
      type: "score",
      score: 1,
      probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 },
      confidence: 0.82,
      legend: { "0": "low", "1": "medium", "2": "high" },
    },
  },
  usage: { input_tokens: 37, output_tokens: 12 },
  warnings: ["scripted-warning"],
  providerMetadata: { trace: "fixture-42" },
};

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

test("explicit OpenRouter connections use Decisions while legacy connections keep the native route", async () => {
  const seen = [];
  const fixture = await startServer(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, body: await readRequest(req) });
    sendJson(res, 200, scriptedResponse);
  });
  try {
    const catalog = validateConnectionCatalog({
      version: 1,
      default: "direct",
      connections: {
        direct: { baseURL: `${fixture.origin}/v1`, model: "jev-latest", apiKeyEnv: "DIRECT_TEST_KEY" },
        openrouter: { adapter: "openrouter", baseURL: `${fixture.origin}/api/v1`, model: "~typesafe/jev-latest", apiKeyEnv: "OPENROUTER_TEST_KEY" },
        legacy: { baseURL: `${fixture.origin}/api/v1`, model: "old-model" },
        local: { baseURL: `${fixture.origin}/home-lab/system-one/v1`, model: "local-compatible" },
      },
    });
    const env = { DIRECT_TEST_KEY: syntheticKey, OPENROUTER_TEST_KEY: "openrouter-synthetic-key" };
    const cases = [
      { id: "direct", path: "/v1/systemone", model: "jev-latest", auth: `Bearer ${syntheticKey}` },
      { id: "openrouter", path: "/api/alpha/decisions", model: "~typesafe/jev-latest", auth: "Bearer openrouter-synthetic-key" },
      { id: "legacy", path: "/api/v1/systemone", model: "old-model", auth: undefined },
      { id: "local", path: "/home-lab/system-one/v1/systemone", model: "local-compatible", auth: undefined },
    ];

    for (const testCase of cases) {
      const { connection, client } = createConnectionClient(catalog, { connectionId: testCase.id }, { env });
      assert.ok(Object.isFrozen(connection));
      const call = testCase.id === "openrouter"
        ? { ...request, providerOptions: { openrouter: { session_id: "scripted-session" } } }
        : request;
      const result = await client.evaluate(call);
      assert.equal(connection.connectionId, testCase.id);
      assert.equal(connection.adapter, testCase.id === "openrouter" ? "openrouter" : undefined);
      assert.equal(result.model, "resolved-by-script");
      assert.equal(result.answers.choice.choice, "yes");
      assert.deepEqual(result.answers.choice.probabilities, { yes: 0.7, no: 0.3 });
      assert.equal(result.answers.choice.confidence, 0.91);
      assert.deepEqual(result.answers.boolean, { type: "boolean", probability: 0.64 });
      assert.equal(result.answers.score.score, 1);
      assert.equal(result.answers.score.confidence, 0.82);
      assert.deepEqual(result.answers.score.legend, { "0": "low", "1": "medium", "2": "high" });
      assert.deepEqual(result.usage, { inputTokens: 37, outputTokens: 12, totalTokens: 49 });
      assert.deepEqual(result.warnings, ["scripted-warning"]);
      assert.deepEqual(result.providerMetadata, testCase.id === "openrouter"
        ? { trace: "fixture-42", openrouter: {} }
        : { trace: "fixture-42" });
      assert.equal(result.response.attempts, 1);
    }

    assert.deepEqual(seen.map(({ url }) => url), cases.map(({ path }) => path));
    for (let index = 0; index < cases.length; index += 1) {
      const sent = seen[index];
      const testCase = cases[index];
      assert.equal(sent.authorization, testCase.auth);
      assert.deepEqual(sent.body, {
        model: testCase.model,
        state: request.state,
        ...(testCase.id === "openrouter" ? { session_id: "scripted-session" } : {}),
        questions: {
          ...request.questions,
          boolean: { ...request.questions.boolean, type: "noul" },
        },
      });
    }
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes(syntheticKey), false);
    assert.equal(serialized.includes("DIRECT_TEST_KEY"), true);
    assert.equal(serialized.includes('"apiKey"'), false);
  } finally {
    await fixture.close();
  }
});

test("one-call connection and model overrides are immutable and do not change the catalog default", async () => {
  const received = [];
  const fixture = await startServer(async (req, res) => {
    received.push({ url: req.url, body: await readRequest(req) });
    sendJson(res, 200, scriptedResponse);
  });
  try {
    const catalog = validateConnectionCatalog({
      version: 1,
      default: "saved",
      connections: {
        saved: { baseURL: `${fixture.origin}/saved/v1`, model: "saved-model" },
        selected: { baseURL: `${fixture.origin}/selected/v1`, model: "configured-model" },
      },
    });
    const oneCall = createConnectionClient(catalog, { connectionId: "selected", model: "temporary-model" });
    await oneCall.client.evaluate(request);
    assert.deepEqual(oneCall.connection, {
      connectionId: "selected",
      baseURL: `${fixture.origin}/selected/v1`,
      model: "temporary-model",
    });
    assert.equal(received[0].url, "/selected/v1/systemone");
    assert.equal(received[0].body.model, "temporary-model");
    assert.equal(resolveConnection(catalog).connectionId, "saved");
    assert.equal(resolveConnection(catalog).model, "saved-model");

    await assert.rejects(
      oneCall.client.evaluate({ ...request, model: "unowned-override" }),
      ConnectionSelectionError,
    );
    assert.equal(received.length, 1);

    const updatedCatalog = validateConnectionCatalog({
      version: 1,
      default: "saved",
      connections: {
        saved: { baseURL: `${fixture.origin}/updated/v1`, model: "updated-model" },
        selected: { baseURL: `${fixture.origin}/redirected/v1`, model: "redirected-model" },
      },
    });
    await oneCall.client.evaluate(request);
    const laterCall = createConnectionClient(updatedCatalog);
    await laterCall.client.evaluate(request);
    assert.equal(received[1].url, "/selected/v1/systemone");
    assert.equal(received[1].body.model, "temporary-model");
    assert.equal(received[2].url, "/updated/v1/systemone");
    assert.equal(received[2].body.model, "updated-model");
  } finally {
    await fixture.close();
  }
});

test("missing default, selected connection, and required environment key fail without fallback or HTTP", async () => {
  let calls = 0;
  const fixture = await startServer(async (_req, res) => {
    calls += 1;
    sendJson(res, 200, scriptedResponse);
  });
  try {
    const noDefault = validateConnectionCatalog({
      version: 1,
      connections: {
        protected: { baseURL: `${fixture.origin}/v1`, model: "protected-model", apiKeyEnv: "MISSING_TEST_KEY" },
      },
    });
    assert.throws(() => resolveConnection(noDefault), /no default/i);
    assert.throws(() => resolveConnection(noDefault, { connectionId: "other" }), /not configured/i);

    const { client } = createConnectionClient(noDefault, { connectionId: "protected" }, { env: {} });
    await assert.rejects(client.evaluate(request), error => {
      assert.ok(error instanceof MissingConnectionKeyError);
      assert.match(error.message, /MISSING_TEST_KEY/);
      assert.equal(error.message.includes(syntheticKey), false);
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    await fixture.close();
  }
});

test("provider rejection and malformed answers fail after one attempt", async t => {
  await t.test("provider rejection", async () => {
    let calls = 0;
    const fixture = await startServer(async (_req, res) => {
      calls += 1;
      sendJson(res, 503, { error: "scripted-unavailable" });
    });
    try {
      const catalog = validateConnectionCatalog({
        version: 1,
        default: "remote",
        connections: { remote: { baseURL: `${fixture.origin}/v1`, model: "model" } },
      });
      const { client } = createConnectionClient(catalog);
      await assert.rejects(client.evaluate(request));
      assert.equal(calls, 1);
    } finally {
      await fixture.close();
    }
  });

  await t.test("malformed answer", async () => {
    let calls = 0;
    const fixture = await startServer(async (_req, res) => {
      calls += 1;
      sendJson(res, 200, { ...scriptedResponse, answers: { ...scriptedResponse.answers, choice: { type: "score", score: 1 } } });
    });
    try {
      const catalog = validateConnectionCatalog({
        version: 1,
        default: "remote",
        connections: { remote: { baseURL: `${fixture.origin}/v1`, model: "model" } },
      });
      const { client } = createConnectionClient(catalog);
      await assert.rejects(client.evaluate(request), /response/i);
      assert.equal(calls, 1);
    } finally {
      await fixture.close();
    }
  });
});

test("timeout and cancellation remain explicit and do not retry", async t => {
  await t.test("timeout", async () => {
    let calls = 0;
    const fixture = await startServer(async (_req, res) => {
      calls += 1;
      setTimeout(() => {
        if (!res.destroyed) sendJson(res, 200, scriptedResponse);
      }, 100);
    });
    try {
      const catalog = validateConnectionCatalog({
        version: 1,
        default: "slow",
        connections: { slow: { baseURL: `${fixture.origin}/v1`, model: "model" } },
      });
      const { client } = createConnectionClient(catalog);
      await assert.rejects(client.evaluate(request, { timeoutMs: 15 }));
      assert.equal(calls, 1);
    } finally {
      await fixture.close();
    }
  });

  await t.test("pre-aborted signal", async () => {
    let calls = 0;
    const fixture = await startServer(async (_req, res) => {
      calls += 1;
      sendJson(res, 200, scriptedResponse);
    });
    try {
      const catalog = validateConnectionCatalog({
        version: 1,
        default: "cancel",
        connections: { cancel: { baseURL: `${fixture.origin}/v1`, model: "model" } },
      });
      const { client } = createConnectionClient(catalog);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(client.evaluate(request, { signal: controller.signal }));
      assert.equal(calls, 0);
    } finally {
      await fixture.close();
    }
  });
});

test("catalog writes are validated, atomic, private, and contain only credential variable names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-one-connections-"));
  const path = join(directory, "nested", "connections.json");
  try {
    const initial = {
      version: 1,
      default: "local",
      connections: {
        local: { baseURL: "http://127.0.0.1:8317/v1/", model: "local-model" },
      },
    };
    const saved = await writeConnectionCatalog(initial, path);
    assert.equal(saved.connections.local.baseURL, "http://127.0.0.1:8317/v1");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await loadConnectionCatalog(path), saved);

    const updated = await updateConnectionCatalog(current => {
      assert.ok(Object.isFrozen(current));
      assert.ok(Object.isFrozen(current.connections.local));
      return {
        ...current,
        connections: {
          ...current.connections,
          local: { ...current.connections.local, apiKeyEnv: "LOCAL_TEST_KEY" },
          direct: { baseURL: "https://api.typesafe.ai/v1", model: "jev-latest", apiKeyEnv: "TYPESAFE_TEST_KEY" },
        },
      };
    }, path);
    assert.equal(updated.connections.direct.apiKeyEnv, "TYPESAFE_TEST_KEY");
    assert.equal(updated.connections.local.apiKeyEnv, "LOCAL_TEST_KEY");

    const contentsBeforeInvalidUpdate = await readFile(path, "utf8");
    await assert.rejects(
      updateConnectionCatalog(current => ({
        ...current,
        connections: {
          ...current.connections,
          local: { ...current.connections.local, apiKey: syntheticKey },
        },
      }), path),
      ConnectionCatalogError,
    );
    assert.equal(await readFile(path, "utf8"), contentsBeforeInvalidUpdate);
    assert.equal(contentsBeforeInvalidUpdate.includes(syntheticKey), false);
    assert.equal(contentsBeforeInvalidUpdate.includes('"apiKey"'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog validation rejects unsafe URL credentials, secret fields, invalid env names, and unknown versions", () => {
  const valid = {
    version: 1,
    default: "one",
    connections: { one: { baseURL: "https://example.test/v1", model: "model" } },
  };
  assert.throws(() => validateConnectionCatalog({ ...valid, extra: "not allowed" }), ConnectionCatalogError);
  assert.throws(() => validateConnectionCatalog({ ...valid, version: 2 }), ConnectionCatalogError);
  assert.throws(() => validateConnectionCatalog({
    ...valid,
    connections: { one: { ...valid.connections.one, adapter: "unknown" } },
  }), ConnectionCatalogError);
  assert.throws(() => validateConnectionCatalog({
    ...valid,
    connections: { one: { baseURL: "https://user:pass@example.test/v1", model: "model" } },
  }), ConnectionCatalogError);
  assert.throws(() => validateConnectionCatalog({
    ...valid,
    connections: { one: { baseURL: "https://example.test/v1", model: "model", apiKeyEnv: "BAD-NAME" } },
  }), ConnectionCatalogError);
  assert.throws(() => validateConnectionCatalog({
    ...valid,
    connections: { one: { baseURL: "https://example.test/v1", model: "model", apiKey: syntheticKey } },
  }), ConnectionCatalogError);
  const withAccessor = { ...valid };
  Object.defineProperty(withAccessor, "connections", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => validateConnectionCatalog(withAccessor), ConnectionCatalogError);
});

test("the default catalog location honors XDG_CONFIG_HOME", () => {
  assert.equal(
    getDefaultCatalogPath({ XDG_CONFIG_HOME: "/tmp/isolated-config", HOME: "/tmp/ignored-home" }),
    "/tmp/isolated-config/system-one/connections.json",
  );
});

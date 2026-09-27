import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const syntheticKey = "cli-synthetic-secret-must-not-print";
const request = {
  state: { evidence: "The caller supplies this decision evidence." },
  questions: {
    choice: {
      type: "choice",
      instructions: "Which option is better supported?",
      criteria: { first: "First option", second: "Second option" },
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

const providerResponse = {
  model: "provider-resolved-model",
  answers: {
    choice: {
      type: "choice",
      choice: "second",
      probabilities: { first: 0.17, second: 0.83 },
      confidence: 0.94,
    },
    boolean: { type: "noul", noul: 0.62 },
    score: {
      type: "score",
      score: 1.53,
      probabilities: { "0": 0.12, "1": 0.23, "2": 0.65 },
      confidence: 0.79,
      legend: { "0": "low", "1": "medium", "2": "high" },
    },
  },
  usage: { input_tokens: 43, output_tokens: 9 },
  warnings: ["scripted-warning"],
  providerMetadata: { trace: "trace-77", echoedCredential: syntheticKey },
};

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readRequest(req);
      const entry = { path: req.url, authorization: req.headers.authorization, body };
      requests.push(entry);
      await handler(req, res, entry, requests.length);
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "scripted backend failed" });
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    requests,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function createHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), "system-one-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configHome = join(directory, "config");
  const catalogPath = join(configHome, "system-one", "connections.json");
  const inputPath = join(directory, "request.json");
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: configHome,
    ["SYSTEM_ONE_CLI_TEST_KEY"]: syntheticKey,
  };
  return {
    directory,
    catalogPath,
    inputPath,
    env,
    async catalog(value) {
      await mkdir(join(configHome, "system-one"), { recursive: true });
      await writeFile(catalogPath, `${JSON.stringify(value)}\n`);
    },
  };
}

function launch(harness, args = [], input = "") {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: harness.directory,
    env: harness.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  child.stdin.end(input);
  return { child, done };
}

async function run(harness, args = [], input = JSON.stringify(request)) {
  return launch(harness, args, input).done;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertFailure(result, code) {
  assert.notEqual(result.code, 0, "failure must have a nonzero exit code");
  assert.equal(result.stdout, "", "failures must leave stdout empty");
  assert.ok(result.stderr.endsWith("\n"));
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, "stderr must contain one JSON error line");
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed), ["error"]);
  assert.equal(parsed.error.code, code);
  assert.equal(typeof parsed.error.message, "string");
  assert.equal(result.stderr.includes(syntheticKey), false, "credential must not appear in errors");
  return parsed.error;
}

test("--help documents the JSON contract and judgment boundary", async t => {
  const harness = await createHarness(t);
  const result = await run(harness, ["--help"], "");
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: system-one/);
  assert.match(result.stdout, /--connection ID/);
  assert.match(result.stdout, /one JSON object to stdout/);
  assert.match(result.stdout, /factual lookup, exact calculations/);
});

test("stdin and --file run the same questions over direct, OpenRouter-compatible, and local routes", async t => {
  const server = await startServer(async (_req, res, entry) => sendJson(res, 200, {
    ...providerResponse,
    providerMetadata: {
      ...providerResponse.providerMetadata,
      echoedCredential: entry.authorization === undefined ? "no-credential" : syntheticKey,
    },
  }));
  t.after(() => server.close());
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "typesafe",
    connections: {
      typesafe: { baseURL: `${server.origin}/v1`, model: "jev-latest", apiKeyEnv: "SYSTEM_ONE_CLI_TEST_KEY" },
      openrouter: { baseURL: `${server.origin}/api/v1`, model: "openrouter/compatible", apiKeyEnv: "SYSTEM_ONE_CLI_TEST_KEY" },
      local: { baseURL: `${server.origin}/home-lab/v1`, model: "local-compatible" },
    },
  });

  const cases = [
    { id: "typesafe", args: ["--model", "one-call-model"], path: "/v1/systemone", model: "one-call-model", auth: `Bearer ${syntheticKey}`, file: false },
    { id: "openrouter", args: ["--connection", "openrouter"], path: "/api/v1/systemone", model: "openrouter/compatible", auth: `Bearer ${syntheticKey}`, file: false },
    { id: "local", args: ["--connection", "local"], path: "/home-lab/v1/systemone", model: "local-compatible", auth: undefined, file: true },
  ];

  for (const testCase of cases) {
    if (testCase.file) {
      await writeFile(harness.inputPath, JSON.stringify(request));
      testCase.args.push("--file", harness.inputPath);
    }
    const result = await run(harness, testCase.args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trimEnd().split("\n").length, 1, "success is exactly one JSON line");
    assert.equal(result.stdout.includes(syntheticKey), false, "credential must not appear in success output");
    const output = JSON.parse(result.stdout);
    assert.equal(output.connectionId, testCase.id);
    assert.equal(output.model, "provider-resolved-model");
    assert.deepEqual(output.answers.choice, {
      type: "choice",
      choice: "second",
      probabilities: { first: 0.17, second: 0.83 },
      confidence: 0.94,
    });
    assert.deepEqual(output.answers.boolean, { type: "boolean", probability: 0.62 });
    assert.deepEqual(output.answers.score, {
      type: "score",
      score: 1.53,
      probabilities: { "0": 0.12, "1": 0.23, "2": 0.65 },
      confidence: 0.79,
      legend: { "0": "low", "1": "medium", "2": "high" },
    });
    assert.deepEqual(output.usage, { inputTokens: 43, outputTokens: 9, totalTokens: 52 });
    assert.deepEqual(output.warnings, ["scripted-warning"]);
    assert.deepEqual(output.providerMetadata, {
      trace: "trace-77",
      echoedCredential: testCase.auth === undefined ? "no-credential" : "[REDACTED]",
    });
    assert.equal(output.response.attempts, 1);
  }

  assert.deepEqual(server.requests.map(entry => entry.path), cases.map(testCase => testCase.path));
  for (let index = 0; index < cases.length; index += 1) {
    const entry = server.requests[index];
    const testCase = cases[index];
    assert.equal(entry.authorization, testCase.auth);
    assert.equal(entry.body.model, testCase.model);
    assert.deepEqual(entry.body.state, request.state);
    assert.deepEqual(entry.body.questions, {
      ...request.questions,
      boolean: { ...request.questions.boolean, type: "noul" },
    });
  }
});

test("sparse provider success does not invent probabilities, confidence, or usage", async t => {
  const server = await startServer(async (_req, res) => sendJson(res, 200, {
    model: "sparse-resolved-model",
    answers: {
      choice: { type: "choice", choice: "second" },
      boolean: { type: "noul", noul: 0.62 },
      score: { type: "score", score: 1 },
    },
  }));
  t.after(() => server.close());
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "sparse",
    connections: { sparse: { baseURL: `${server.origin}/v1`, model: "configured-model" } },
  });

  const result = await run(harness);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.connectionId, "sparse");
  assert.equal(output.model, "sparse-resolved-model");
  assert.deepEqual(output.answers, {
    choice: { type: "choice", choice: "second" },
    boolean: { type: "boolean", probability: 0.62 },
    score: { type: "score", score: 1 },
  });
  assert.deepEqual(output.usage, {});
  assert.deepEqual(output.warnings, []);
  assert.equal(output.response.attempts, 1);
  assert.equal(server.requests.length, 1);
});

test("missing default and missing selected credential fail explicitly without a request", async t => {
  let calls = 0;
  const server = await startServer(async (_req, res) => {
    calls += 1;
    sendJson(res, 200, providerResponse);
  });
  t.after(() => server.close());
  const harness = await createHarness(t);

  await harness.catalog({
    version: 1,
    connections: { only: { baseURL: `${server.origin}/v1`, model: "model" } },
  });
  const noDefault = await run(harness);
  assertFailure(noDefault, "CONNECTION_SELECTION_ERROR");

  await harness.catalog({
    version: 1,
    default: "protected",
    connections: {
      protected: { baseURL: `${server.origin}/v1`, model: "model", apiKeyEnv: "MISSING_SYSTEM_ONE_KEY" },
      backup: { baseURL: `${server.origin}/backup/v1`, model: "backup-model" },
    },
  });
  const missingKey = await run(harness);
  assertFailure(missingKey, "MISSING_CREDENTIAL");
  assert.equal(calls, 0);
});

test("bad JSON, model-in-body, and incomplete requests return sanitized JSON failures", async t => {
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "local",
    connections: { local: { baseURL: "http://127.0.0.1:1/v1", model: "model" } },
  });

  assertFailure(await run(harness, [], "{\"state\":"), "INVALID_JSON");
  assertFailure(await run(harness, [], JSON.stringify({ state: {}, questions: {}, model: syntheticKey })), "INVALID_INPUT");
  assertFailure(await run(harness, [], JSON.stringify({ state: {} })), "INVALID_INPUT");
  assertFailure(await run(harness, ["--not-an-option"]), "USAGE_ERROR");
});

test("timeout is an explicit failure with one provider request", async t => {
  const server = await startServer((_req, res) => new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!res.destroyed) sendJson(res, 200, providerResponse);
      resolve();
    }, 500);
    res.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  }));
  t.after(() => server.close());
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "slow",
    connections: { slow: { baseURL: `${server.origin}/v1`, model: "model" } },
  });

  const result = await run(harness, ["--timeout-ms", "250"]);
  assertFailure(result, "TIMEOUT");
  assert.equal(server.requests.length, 1);
});

test("SIGINT cancellation is an explicit failure, not a partial answer", async t => {
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const server = await startServer(async (_req, res, entry) => {
    received(entry);
    await new Promise(resolve => res.once("close", resolve));
  });
  t.after(() => server.close());
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "slow",
    connections: { slow: { baseURL: `${server.origin}/v1`, model: "model" } },
  });

  const child = launch(harness, [], JSON.stringify(request));
  t.after(() => child.child.kill("SIGKILL"));
  let ready;
  try {
    ready = await withTimeout(Promise.race([
      requestReceived.then(entry => ({ kind: "request", entry })),
      child.done.then(result => ({ kind: "exit", result })),
    ]), 3_000, "CLI provider request");
  } catch (error) {
    child.child.kill("SIGKILL");
    const result = await withTimeout(child.done, 2_000, "CLI cleanup after startup failure");
    throw new Error(`${error.message}; CLI exited ${result.code} (${result.signal}): ${result.stderr}`);
  }
  assert.equal(ready.kind, "request", `CLI exited before its provider request: ${ready.result?.stderr}`);
  const cancelledAt = Date.now();
  child.child.kill("SIGINT");
  let result;
  try {
    result = await withTimeout(child.done, 2_000, "SIGINT cancellation");
  } catch (error) {
    child.child.kill("SIGKILL");
    throw error;
  }
  assert.ok(Date.now() - cancelledAt < 2_000, "cancellation must exit promptly");
  assertFailure(result, "CANCELLED");
  assert.equal(result.code, 130);
  assert.equal(server.requests.length, 1);
});

test("malformed provider answers fail without a success-shaped result", async t => {
  const server = await startServer(async (_req, res) => sendJson(res, 200, {
    ...providerResponse,
    answers: { ...providerResponse.answers, choice: { type: "score", score: 2 } },
  }));
  t.after(() => server.close());
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "malformed",
    connections: { malformed: { baseURL: `${server.origin}/v1`, model: "model" } },
  });

  assertFailure(await run(harness), "MALFORMED_RESPONSE");
  assert.equal(server.requests.length, 1);
});

test("provider rejection makes one attempt and never falls back to another connection", async t => {
  const server = await startServer(async (_req, res) => sendJson(res, 503, {
    error: `scripted rejection containing ${syntheticKey}`,
  }));
  t.after(() => server.close());
  const harness = await createHarness(t);
  await harness.catalog({
    version: 1,
    default: "primary",
    connections: {
      primary: { baseURL: `${server.origin}/primary/v1`, model: "primary-model", apiKeyEnv: "SYSTEM_ONE_CLI_TEST_KEY" },
      fallback: { baseURL: `${server.origin}/fallback/v1`, model: "fallback-model" },
    },
  });

  const result = await run(harness);
  const error = assertFailure(result, "PROVIDER_REJECTED");
  assert.equal(error.status, 503);
  assert.deepEqual(server.requests.map(entry => entry.path), ["/primary/v1/systemone"]);
  assert.equal(server.requests[0].authorization, `Bearer ${syntheticKey}`);
});

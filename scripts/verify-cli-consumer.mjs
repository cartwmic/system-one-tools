import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const [consumerArgument, sourceArgument] = process.argv.slice(2);
if (!consumerArgument || !sourceArgument) throw new Error("Usage: verify-cli-consumer.mjs CONSUMER SOURCE_ROOT");
const consumer = await realpath(consumerArgument);
const sourceRoot = await realpath(sourceArgument);
const sharedEntry = await realpath(join(consumer, "node_modules/@cartwmic/system-one-connections/dist/index.js"));
const cliEntry = await realpath(join(consumer, "node_modules/@cartwmic/system-one-cli/dist/cli.js"));
const cliBin = join(consumer, "node_modules/.bin/system-one");

function isWithin(path, directory) {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

assert.ok(isWithin(sharedEntry, consumer), `shared dependency resolved outside consumer: ${sharedEntry}`);
assert.ok(isWithin(cliEntry, consumer), `CLI entry resolved outside consumer: ${cliEntry}`);
assert.equal(isWithin(sharedEntry, sourceRoot), false, "shared dependency must not resolve from the source tree");
assert.equal(isWithin(cliEntry, sourceRoot), false, "CLI entry must not resolve from the source tree");
assert.equal(process.versions.node.split(".")[0] >= 20, true, `Node 20+ required, got ${process.version}`);

const expectedPlatform = process.env.SYSTEM_ONE_EXPECT_PLATFORM;
if (expectedPlatform) assert.equal(process.platform, expectedPlatform);
const expectedNodeMajor = process.env.SYSTEM_ONE_EXPECT_NODE_MAJOR;
if (expectedNodeMajor) assert.equal(process.versions.node.split(".")[0], expectedNodeMajor);

const syntheticKey = "packaged-cli-synthetic-secret";
const request = {
  state: { evidence: "The caller supplied evidence for this packaged-consumer check." },
  questions: {
    decision: {
      type: "choice",
      instructions: "Which option is better supported?",
      criteria: { wait: "Wait for the check", proceed: "Proceed now" },
    },
  },
};
const providerResponse = {
  model: "packaged-resolved-model",
  answers: {
    decision: {
      type: "choice",
      choice: "wait",
      probabilities: { wait: 0.81, proceed: 0.19 },
      confidence: 0.93,
    },
  },
  usage: { input_tokens: 23, output_tokens: 7 },
  providerMetadata: { fixture: "packed-consumer", echoedCredential: syntheticKey },
};

const received = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  received.push({ path: req.url, authorization: req.headers.authorization, body });
  if (req.url === "/reject/v1/systemone") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `scripted rejection includes ${syntheticKey}` }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(providerResponse));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
const home = await mkdtemp(join(tmpdir(), "system-one-packed-cli-"));
const xdg = join(home, "xdg");
const catalogPath = join(xdg, "system-one/connections.json");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  PACKAGED_CLI_KEY: syntheticKey,
  PACKAGED_MISSING_KEY: "",
};

async function writeCatalog(catalog) {
  await mkdir(join(xdg, "system-one"), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  assert.equal((await readFile(catalogPath, "utf8")).includes(syntheticKey), false, "credentials must not be stored in the catalog");
}

function invokeCli(input = request) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliBin, [], { cwd: consumer, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
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
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function assertFailure(result, code) {
  assert.notEqual(result.code, 0, "packaged CLI failures must exit nonzero");
  assert.equal(result.stdout, "", "packaged CLI failures must keep stdout empty");
  assert.equal(result.stderr.endsWith("\n"), true);
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, "packaged CLI failure must be one JSON line");
  const error = JSON.parse(lines[0]).error;
  assert.equal(error.code, code);
  assert.equal(result.stderr.includes(syntheticKey), false, "credential must not appear in CLI errors");
  return error;
}

try {
  await writeCatalog({
    version: 1,
    default: "consumer",
    connections: {
      consumer: { baseURL: `${origin}/consumer/v1`, model: "consumer-model", apiKeyEnv: "PACKAGED_CLI_KEY" },
    },
  });
  const success = await invokeCli();
  assert.equal(success.code, 0, success.stderr);
  assert.equal(success.stderr, "");
  assert.equal(success.stdout.trimEnd().split("\n").length, 1);
  assert.equal(success.stdout.includes(syntheticKey), false, "credential must not appear in successful output");
  const result = JSON.parse(success.stdout);
  assert.equal(result.connectionId, "consumer");
  assert.equal(result.model, "packaged-resolved-model");
  assert.deepEqual(result.answers.decision, {
    type: "choice",
    choice: "wait",
    probabilities: { wait: 0.81, proceed: 0.19 },
    confidence: 0.93,
  });
  assert.deepEqual(result.usage, { inputTokens: 23, outputTokens: 7, totalTokens: 30 });
  assert.deepEqual(result.providerMetadata, { fixture: "packed-consumer", echoedCredential: "[REDACTED]" });
  assert.deepEqual(received.map((entry) => entry.path), ["/consumer/v1/systemone"]);
  assert.equal(received[0].authorization, `Bearer ${syntheticKey}`);
  assert.equal(received[0].body.model, "consumer-model");
  assert.deepEqual(received[0].body.state, request.state);
  assert.deepEqual(received[0].body.questions, request.questions);

  await writeCatalog({
    version: 1,
    connections: { only: { baseURL: `${origin}/consumer/v1`, model: "consumer-model" } },
  });
  assertFailure(await invokeCli(), "CONNECTION_SELECTION_ERROR");
  assert.equal(received.length, 1, "missing default must fail before the provider is contacted");

  await writeCatalog({
    version: 1,
    default: "protected",
    connections: {
      protected: { baseURL: `${origin}/consumer/v1`, model: "consumer-model", apiKeyEnv: "PACKAGED_MISSING_KEY" },
    },
  });
  const withoutKey = await invokeCli();
  assertFailure(withoutKey, "MISSING_CREDENTIAL");
  assert.equal(received.length, 1, "missing credentials must fail before the provider is contacted");

  await writeCatalog({
    version: 1,
    default: "reject",
    connections: {
      reject: { baseURL: `${origin}/reject/v1`, model: "reject-model", apiKeyEnv: "PACKAGED_CLI_KEY" },
    },
  });
  const rejected = await invokeCli();
  assert.equal(assertFailure(rejected, "PROVIDER_REJECTED").status, 503);
  assert.deepEqual(received.map((entry) => entry.path), ["/consumer/v1/systemone", "/reject/v1/systemone"]);
  assert.equal(received.length, 2, "provider rejection must not be retried or routed to another connection");

  console.log(`PASS packed CLI consumer: ${process.platform} ${process.version}; shared SDK dependency resolved under ${consumer}`);
} finally {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await rm(home, { recursive: true, force: true });
}

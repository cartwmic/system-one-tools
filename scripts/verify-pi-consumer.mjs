import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [consumerArgument, sourceArgument] = process.argv.slice(2);
if (!consumerArgument || !sourceArgument) throw new Error("Usage: verify-pi-consumer.mjs CONSUMER SOURCE_ROOT");
const consumer = await realpath(consumerArgument);
const sourceRoot = await realpath(sourceArgument);
const sharedEntry = await realpath(join(consumer, "node_modules/@cartwmic/system-one-connections/dist/index.js"));
const extensionEntry = await realpath(join(consumer, "node_modules/@cartwmic/pi-system-one/src/index.js"));

function isWithin(path, directory) {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !rel.startsWith(".."));
}

assert.ok(isWithin(sharedEntry, consumer), `shared dependency resolved outside consumer: ${sharedEntry}`);
assert.ok(isWithin(extensionEntry, consumer), `Pi extension resolved outside consumer: ${extensionEntry}`);
assert.equal(isWithin(sharedEntry, sourceRoot), false, "Pi shared dependency must not resolve from the source tree");
assert.equal(isWithin(extensionEntry, sourceRoot), false, "Pi extension must not resolve from the source tree");

const piCommand = process.platform === "win32" ? "where" : "which";
const piExecutable = execFileSync(piCommand, ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
const piEntry = await realpath(piExecutable);
const piPackageRoot = resolve(dirname(piEntry), "../..");
const piModuleUrl = (path) => pathToFileURL(join(piPackageRoot, path)).href;
await import(piModuleUrl("dist/index.js"));
await import(piModuleUrl("dist/core/extensions/loader.js"));

async function startDecisionServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
      if (question.type === "choice") {
        answers[name] = {
          type: "choice",
          choice: "wait",
          probabilities: { wait: 0.84, proceed: 0.16 },
          confidence: 0.92,
        };
      } else if (question.type === "noul") {
        answers[name] = { type: "noul", noul: 0.71 };
      } else {
        answers[name] = { type: "score", score: 1 };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "packed-pi-resolved-model", answers, usage: { input_tokens: 19, output_tokens: 6 } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    requests,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function startScriptedPiProvider() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    const hasToolResult = body.messages?.some((message) => message.role === "tool");
    const toolIsOffered = body.tools?.some((tool) => tool.function?.name === "system_one") ?? false;
    const shouldCallTool = toolIsOffered && !hasToolResult;
    const delta = shouldCallTool
      ? {
          role: "assistant",
          tool_calls: [{
            id: "packed_system_one_call",
            type: "function",
            function: {
              name: "system_one",
              arguments: JSON.stringify({
                state: { evidence: "The supplied release note says a required check is failing." },
                questions: {
                  release: {
                    type: "choice",
                    instructions: "Which release decision is better supported?",
                    criteria: { wait: "Wait for the check", proceed: "Proceed now" },
                  },
                },
              }),
            },
          }],
        }
      : {
          role: "assistant",
          content: hasToolResult
            ? "Packaged Pi completed the scripted System One judgment."
            : "Packaged Pi completed without invoking System One.",
        };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({
      id: "packed-pi-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "scripted-pi-model",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "packed-pi-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "scripted-pi-model",
      choices: [{ index: 0, delta: {}, finish_reason: shouldCallTool ? "tool_calls" : "stop" }],
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    requests,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function runPi(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(piExecutable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

const root = await mkdtemp(join(tmpdir(), "system-one-packed-pi-"));
const home = join(root, "home");
const xdg = join(root, "xdg");
const agentDir = join(root, "pi-agent");
const project = join(root, "project");
const decisionServer = await startDecisionServer();
const piProvider = await startScriptedPiProvider();

async function writeOwnerPreferences(agentAccess) {
  const directory = join(agentDir, "system-one");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "preferences.json"), `${JSON.stringify({ version: 1, agentAccess, defaultMode: "proactive" }, null, 2)}\n`);
}

async function writeProjectConflict(agentAccess) {
  const directory = join(project, ".pi");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), `${JSON.stringify({
    systemOne: { agentAccess, defaultConnection: "project" },
    quietStartup: true,
  }, null, 2)}\n`);
}

async function runTurn() {
  return runPi([
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--provider", "scripted",
    "--model", "scripted-model",
    "--extension", extensionEntry,
    "--approve",
    "Use System One to judge the supplied release evidence.",
  ], {
    cwd: project,
    timeoutMs: 30_000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      SCRIPTED_PI_API_KEY: "packed-pi-synthetic-provider-key",
    },
  });
}

try {
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      scripted: {
        baseUrl: `${piProvider.origin}/v1`,
        api: "openai-completions",
        apiKey: "$SCRIPTED_PI_API_KEY",
        models: [{
          id: "scripted-model",
          name: "Scripted packaged Pi model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        }],
      },
    },
  }, null, 2)}\n`);
  const catalogDirectory = join(xdg, "system-one");
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(join(catalogDirectory, "connections.json"), `${JSON.stringify({
    version: 1,
    default: "owner",
    connections: {
      owner: { baseURL: `${decisionServer.origin}/owner/v1`, model: "owner-model" },
      project: { baseURL: `${decisionServer.origin}/project/v1`, model: "project-model" },
    },
  }, null, 2)}\n`);

  await writeOwnerPreferences(true);
  await writeProjectConflict(false);
  const success = await runTurn();
  assert.equal(success.timedOut, false, `Pi timed out.\n${success.stdout}\n${success.stderr}`);
  assert.equal(success.status, 0, `Pi failed.\n${success.stdout}\n${success.stderr}`);
  assert.match(success.stdout, /Packaged Pi completed the scripted System One judgment/i);
  assert.ok(piProvider.requests.length >= 2, "the packed extension must complete a real Pi tool round-trip");
  const firstRequest = piProvider.requests[0];
  assert.equal(firstRequest.path, "/v1/chat/completions");
  assert.equal(firstRequest.authorization, "Bearer packed-pi-synthetic-provider-key");
  assert.ok(firstRequest.body.tools?.some((tool) => tool.function?.name === "system_one"),
    "user-global opt-in should offer the tool despite the conflicting project-local off setting");
  assert.match(JSON.stringify(firstRequest.body.messages), /Consider more eligible bounded intermediate judgments/);
  assert.equal(decisionServer.requests.length, 1);
  assert.equal(decisionServer.requests[0].path, "/owner/v1/systemone", "project settings must not redirect the packaged extension");
  assert.equal(decisionServer.requests[0].body.model, "owner-model");
  assert.deepEqual(decisionServer.requests[0].body.state, {
    evidence: "The supplied release note says a required check is failing.",
  });
  assert.deepEqual(Object.keys(decisionServer.requests[0].body).sort(), ["model", "questions", "state"]);

  await writeOwnerPreferences(false);
  await writeProjectConflict(true);
  const disabled = await runTurn();
  assert.equal(disabled.timedOut, false, `default-off Pi timed out.\n${disabled.stdout}\n${disabled.stderr}`);
  assert.equal(disabled.status, 0, `default-off Pi failed.\n${disabled.stdout}\n${disabled.stderr}`);
  assert.match(disabled.stdout, /without invoking System One/i);
  assert.equal(piProvider.requests.at(-1).body.tools?.some((tool) => tool.function?.name === "system_one"), false,
    "project-local on must not enable agent access against the user-global off setting");
  assert.equal(decisionServer.requests.length, 1, "disabled agent calls must not reach either configured endpoint");
  assert.equal(decisionServer.requests.some((entry) => entry.path.startsWith("/project/")), false);

  console.log(`PASS packed Pi consumer: real ${piExecutable} loader and tool call; shared dependency resolved under ${consumer}`);
} finally {
  await Promise.all([decisionServer.close(), piProvider.close()]);
  await rm(root, { recursive: true, force: true });
}

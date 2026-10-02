import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureEnvironment } from "./scripted-fetch-guard.mjs";
import { installConsumer, packPackages } from "./package-utils.mjs";

const packageNames = [
  "@cartwmic/system-one-connections",
  "@cartwmic/system-one-cli",
  "@cartwmic/pi-system-one",
];
const root = await mkdtemp(join(tmpdir(), "system-one-cross-caller-journey-"));
const cliConsumer = join(root, "cli-consumer");
const piConsumer = join(root, "pi-consumer");
let artifacts;
let piProvider;

const home = join(root, "user-home");
const xdg = join(root, "xdg");
const agentDir = join(root, "pi-agent");
const project = join(root, "project");
const received = [];
const decisionServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(req.method, "POST");
  assert.ok(["/api/alpha/decisions", "/api/v1/systemone"].includes(req.url));
  assert.equal(req.headers.authorization, req.url === "/api/v1/systemone" ? "Bearer dummy-native" : "Bearer dummy-cli");
  assert.equal(body.model, req.url === "/api/v1/systemone" ? "native-only" : "~typesafe/jev-latest");
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.deepEqual(Object.keys(body.questions), ["release"]);
  assert.equal(body.questions.release.type, "choice");
  assert.deepEqual(Object.keys(body.questions.release.criteria).sort(), ["proceed", "wait"]);
  assert.deepEqual(Object.keys(body.state), ["evidence"]);
  assert.equal(typeof body.state.evidence, "string");
  received.push({ path: req.url, authorization: req.headers.authorization, body });
  const answers = {};
  for (const [name, question] of Object.entries(body.questions)) {
    if (question.type === "choice") {
      answers[name] = {
        type: "choice",
        choice: "wait",
        probabilities: { wait: 0.86, proceed: 0.14 },
        confidence: 0.93,
      };
    } else if (question.type === "noul") {
      answers[name] = { type: "noul", noul: 0.74 };
    } else {
      answers[name] = { type: "score", score: 1 };
    }
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model: "cross-caller-resolved-model",
    answers,
    usage: { input_tokens: 31, output_tokens: 11 },
    providerMetadata: { journey: "one-user-home" },
  }));
});

async function startPiProvider() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer scripted-cross-caller-pi-key");
    assert.equal(body.model, "scripted-model");
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    const toolResult = body.messages?.find((message) => message.role === "tool");
    const hasToolResult = Boolean(toolResult);
    if (toolResult) {
      const content = typeof toolResult.content === "string" ? toolResult.content : toolResult.content.map((part) => part.text ?? "").join("\n");
      const result = JSON.parse(content).result;
      assert.equal(result.stopReason, "stop");
      assert.equal(result.answers.release.choice, "wait");
      assert.deepEqual(result.answers.release.probabilities, { wait: 0.86, proceed: 0.14 });
    }
    const toolIsOffered = body.tools?.some((tool) => tool.function?.name === "system_one") ?? false;
    const userMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    const userPrompt = typeof userMessage?.content === "string"
      ? userMessage.content
      : userMessage?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
    const shouldCallTool = toolIsOffered && !hasToolResult;
    const delta = shouldCallTool
      ? {
          role: "assistant",
          tool_calls: [{
            id: "cross_caller_system_one_call",
            type: "function",
            function: {
              name: "system_one",
              arguments: JSON.stringify({
                state: { evidence: userPrompt },
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
          content: "Pi completed the independent-native journey.",
        };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({
      id: "cross-caller-pi-provider",
      object: "chat.completion.chunk",
      created: 1,
      model: "scripted-pi-model",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "cross-caller-pi-provider",
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

async function loadPiRuntime() {
  const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  const { realpath } = await import("node:fs/promises");
  const entry = await realpath(piBin);
  const packageRoot = resolve(dirname(entry), "../..");
  const moduleUrl = (path) => pathToFileURL(join(packageRoot, path)).href;
  const pi = await import(moduleUrl("dist/index.js"));
  const extensions = await import(moduleUrl("dist/core/extensions/index.js"));
  const loader = await import(moduleUrl("dist/core/extensions/loader.js"));
  const { createEventBus } = await import(moduleUrl("dist/core/event-bus.js"));
  const { SessionManager } = await import(moduleUrl("dist/core/session-manager.js"));
  return { ...pi, ...extensions, ...loader, createEventBus, SessionManager, piBin };
}

function runCli(binary, consumer, env, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { cwd: consumer, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function runPi(piBin, extensionPath, prompt, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(piBin, [
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-context-files",
      "--provider", "scripted",
      "--model", "scripted-model",
      "--extension", env.SYSTEM_ONE_NATIVE_EXTENSION,
      "--extension", extensionPath,
      "--approve",
      prompt,
    ], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

try {
  artifacts = await packPackages(join(root, "artifacts"), packageNames);
  await installConsumer(cliConsumer, artifacts, [
    "@cartwmic/system-one-connections",
    "@cartwmic/system-one-cli",
  ]);
  await installConsumer(piConsumer, artifacts, [
    "@cartwmic/pi-system-one",
  ]);

  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await new Promise((resolve, reject) => {
    decisionServer.once("error", reject);
    decisionServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = decisionServer.address();
  const decisionOrigin = `http://127.0.0.1:${port}`;
  piProvider = await startPiProvider();
  const runtime = await loadPiRuntime();
  const agentExtensionPath = join(piConsumer, "node_modules/@cartwmic/pi-system-one/src/index.js");

  const catalogPath = join(xdg, "system-one/connections.json");
  const preferencesPath = join(agentDir, "system-one/preferences.json");
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, JSON.stringify({ version: 1, default: "owner", connections: {
    owner: { adapter: "openrouter", baseURL: `${decisionOrigin}/api/v1`, model: "~typesafe/jev-latest", apiKeyEnv: "CLI_FIXTURE_KEY" },
    project: { baseURL: `${decisionOrigin}/project/v1`, model: "project-model" },
  } }));
  const catalogBytes = await readFile(catalogPath, "utf8");
  await mkdir(dirname(preferencesPath), { recursive: true });
  await writeFile(preferencesPath, JSON.stringify({ version: 1, agentAccess: true, defaultMode: "proactive", defaultClassifier: { provider: "openrouter", id: "native-only" } }));
  const nativeExtension = join(root, "native-provider.mjs");
  await writeFile(nativeExtension, `import { classify } from ${JSON.stringify(pathToFileURL(join(resolve(dirname(await (await import("node:fs/promises")).realpath(runtime.piBin)), "../.."), "node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one.js")).href)};
export default pi => pi.registerProvider("openrouter", { classifiers: { "typesafe-system-one": { classify } }, baseUrl: ${JSON.stringify(`${decisionOrigin}/api/v1`)}, apiKey: "dummy-native", models: [{type:"classifier", api:"typesafe-system-one",id:"native-only",name:"Native only",cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}] });`);
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi/settings.json"), `${JSON.stringify({
    systemOne: { agentAccess: false, defaultConnection: "project" },
  }, null, 2)}\n`);
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      scripted: {
        baseUrl: `${piProvider.origin}/v1`,
        api: "openai-completions",
        apiKey: "$CROSS_CALLER_PI_KEY",
        models: [{
          id: "scripted-model",
          name: "Scripted cross-caller Pi model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        }],
      },
    },
  }, null, 2)}\n`);

  const childEnv = fixtureEnvironment(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    CROSS_CALLER_PI_KEY: "scripted-cross-caller-pi-key",
    CLI_FIXTURE_KEY: "dummy-cli",
    SYSTEM_ONE_NATIVE_EXTENSION: nativeExtension,
    SYSTEM_ONE_FIXTURE_URLS: JSON.stringify([`${decisionOrigin}/api/alpha/decisions`, `${decisionOrigin}/api/v1/systemone`, `${piProvider.origin}/v1/chat/completions`]),
    NODE_OPTIONS: `--import=${pathToFileURL(resolve("scripts/scripted-fetch-guard.mjs")).href}`,
  });
  const piPrompt = "The release note says its required check is failing. Use System One to judge whether this release is ready.";
  const request = {
    state: { evidence: "The caller supplied shared-catalog evidence." },
    questions: {
      release: {
        type: "choice",
        instructions: "Which release decision is better supported?",
        criteria: { wait: "Wait for the failing check", proceed: "Proceed now" },
      },
    },
  };

  const cli = await runCli(join(cliConsumer, "node_modules/.bin/system-one"), cliConsumer, childEnv, request);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.equal(cli.stdout.trimEnd().split("\n").length, 1);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.connectionId, "owner");
  assert.equal(cliResult.model, "cross-caller-resolved-model");
  assert.deepEqual(cliResult.answers.release.probabilities, { wait: 0.86, proceed: 0.14 });
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/api/alpha/decisions");
  assert.equal(received[0].body.model, "~typesafe/jev-latest");
  assert.deepEqual(received[0].body.state, request.state);

  const pi = await runPi(runtime.piBin, agentExtensionPath, piPrompt, childEnv);
  assert.equal(pi.code, 0, `Pi journey failed.\n${pi.stdout}\n${pi.stderr}`);
  assert.match(pi.stdout, /Pi completed the independent-native journey/);
  assert.ok(piProvider.requests.length >= 2, "the real Pi turn should complete a tool round-trip");
  assert.ok(piProvider.requests[0].body.tools?.some((tool) => tool.function?.name === "system_one"),
    "user-global settings should enable Pi despite the conflicting project-local off setting");
  assert.equal(received.length, 2, "the CLI and Pi should each complete one decision evaluation");
  assert.deepEqual(received.map((entry) => entry.path), ["/api/alpha/decisions", "/api/v1/systemone"]);
  assert.deepEqual(received.map((entry) => entry.body.model), ["~typesafe/jev-latest", "native-only"]);
  assert.match(piPrompt, /required check is failing/i);
  assert.deepEqual(received[1].body.state, { evidence: piPrompt },
    "Pi's decision evidence must come from the actual user prompt, not a scripted-provider fixture");
  assert.equal(received.some((entry) => entry.path.startsWith("/project/")), false,
    "project-local destination settings must not receive either caller's request");
  assert.equal(received[0].authorization, "Bearer dummy-cli");
  assert.equal(received[1].authorization, "Bearer dummy-native");

  assert.equal(await readFile(catalogPath, "utf8"), catalogBytes, "Pi must not mutate CLI catalog bytes");
  await rm(catalogPath);
  const absent = await runPi(runtime.piBin, agentExtensionPath, piPrompt, childEnv);
  assert.equal(absent.code, 0, absent.stderr);
  assert.match(absent.stdout, /Pi completed the independent-native journey/);
  assert.equal(received.length, 3);
  assert.equal(received[2].path, "/api/v1/systemone");
  assert.equal(received[2].body.model, "native-only");
  console.log("PASS independent catalog/default bytes and native Pi with catalog absent");
} finally {
  if (piProvider) await piProvider.close();
  await new Promise((resolve) => {
    decisionServer.close(() => resolve());
    decisionServer.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
}

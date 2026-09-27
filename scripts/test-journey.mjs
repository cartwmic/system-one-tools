import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    const hasToolResult = body.messages?.some((message) => message.role === "tool");
    const toolIsOffered = body.tools?.some((tool) => tool.function?.name === "system_one") ?? false;
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
                state: { evidence: "The release note says its required check is failing." },
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
          content: "Pi completed the shared-catalog journey.",
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

function scriptedUi({ selects = [], inputs = [] } = {}) {
  const calls = { selects: [], inputs: [], notifications: [] };
  return {
    calls,
    async select(title, options) {
      calls.selects.push({ title, options: [...options] });
      assert.ok(selects.length > 0, `Unexpected /so settings selection: ${title}`);
      const selected = selects.shift();
      assert.ok(options.includes(selected), `${selected} is not an option for ${title}: ${options.join(", ")}`);
      return selected;
    },
    async input(title, placeholder) {
      calls.inputs.push({ title, placeholder });
      assert.ok(inputs.length > 0, `Unexpected /so settings input: ${title}`);
      return inputs.shift();
    },
    notify(message, type = "info") {
      calls.notifications.push({ message, type });
    },
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

async function withUserHome(values, run) {
  const keys = ["HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await run();
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

async function loadOwnerExtensions(runtime, projectPath, extensionPath) {
  runtime.clearExtensionCache();
  const eventBus = runtime.createEventBus();
  const loaded = await runtime.loadExtensions([extensionPath], projectPath, eventBus, runtime.createExtensionRuntime());
  assert.deepEqual(loaded.errors, [], "Pi's real extension loader should load the integrated packaged entry");
  const sessionManager = runtime.SessionManager.inMemory(projectPath);
  const runner = new runtime.ExtensionRunner(loaded.extensions, loaded.runtime, projectPath, sessionManager, {});
  const activeTools = ["read", "bash", "other_tool"];
  runner.bindCore({
    sendMessage() {},
    sendUserMessage() {},
    appendEntry: (type, data) => sessionManager.appendCustomEntry(type, data),
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      promptGuidelines: definition.promptGuidelines,
      sourceInfo,
    })),
    setActiveTools: (names) => activeTools.splice(0, activeTools.length, ...names),
    refreshTools() {},
    getCommands: () => runner.getRegisteredCommands(),
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
  }, {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: projectPath, sections: {} }),
  });
  await runner.emit({ type: "session_start", reason: "startup" });
  return { runner, sessionManager, activeTools };
}

async function invokeSettings(runner, args, ui) {
  const command = runner.getRegisteredCommands().find((entry) => entry.name === "so");
  assert.ok(command, "the packed Pi extension should register /so");
  assert.equal(runner.getRegisteredCommands().filter((entry) => entry.name === "so").length, 1);
  const context = Object.create(runner.createContext());
  Object.defineProperty(context, "ui", { value: ui, configurable: true });
  await command.handler(args, context);
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
    "@cartwmic/system-one-connections",
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

  const userEnv = { HOME: home, XDG_CONFIG_HOME: xdg, PI_CODING_AGENT_DIR: agentDir };
  await withUserHome(userEnv, async () => {
    const harness = await loadOwnerExtensions(runtime, project, agentExtensionPath);
    try {
      await invokeSettings(harness.runner, "settings", scriptedUi({
        selects: ["Manage connections", "Create a connection"],
        inputs: ["owner", `${decisionOrigin}/shared/v1`, "shared-model", ""],
      }));
      await invokeSettings(harness.runner, "settings", scriptedUi({
        selects: ["Manage connections", "Create a connection"],
        inputs: ["project", `${decisionOrigin}/project/v1`, "project-model", ""],
      }));
      await invokeSettings(harness.runner, "settings", scriptedUi({
        selects: ["Set catalog default connection", "owner"],
      }));
      await invokeSettings(harness.runner, "settings", scriptedUi({
        selects: ["Set persistent agent defaults", "On", "Proactive"],
      }));
    } finally {
      harness.runner.invalidate("cross-caller journey setup complete");
    }
  });

  const catalogPath = join(xdg, "system-one/connections.json");
  const preferencesPath = join(agentDir, "system-one/preferences.json");
  const savedCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const savedPreferences = JSON.parse(await readFile(preferencesPath, "utf8"));
  assert.equal(savedCatalog.default, "owner", "the actual /so settings flow should save the user-global default");
  assert.equal(savedCatalog.connections.owner.baseURL, `${decisionOrigin}/shared/v1`);
  assert.equal(savedCatalog.connections.project.baseURL, `${decisionOrigin}/project/v1`);
  assert.deepEqual(savedPreferences, { version: 1, agentAccess: true, defaultMode: "proactive" });

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

  const childEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    CROSS_CALLER_PI_KEY: "scripted-cross-caller-pi-key",
  };
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
  assert.equal(received[0].path, "/shared/v1/systemone");
  assert.equal(received[0].body.model, "shared-model");
  assert.deepEqual(received[0].body.state, request.state);

  const pi = await runPi(runtime.piBin, agentExtensionPath, "Use System One to judge the supplied release evidence.", childEnv);
  assert.equal(pi.code, 0, `Pi journey failed.\n${pi.stdout}\n${pi.stderr}`);
  assert.match(pi.stdout, /Pi completed the shared-catalog journey/);
  assert.ok(piProvider.requests.length >= 2, "the real Pi turn should complete a tool round-trip");
  assert.ok(piProvider.requests[0].body.tools?.some((tool) => tool.function?.name === "system_one"),
    "user-global settings should enable Pi despite the conflicting project-local off setting");
  assert.equal(received.length, 2, "the CLI and Pi should each complete one decision evaluation");
  assert.deepEqual(received.map((entry) => entry.path), ["/shared/v1/systemone", "/shared/v1/systemone"]);
  assert.deepEqual(received.map((entry) => entry.body.model), ["shared-model", "shared-model"]);
  assert.deepEqual(received[1].body.state, {
    evidence: "The release note says its required check is failing.",
  });
  assert.equal(received.some((entry) => entry.path.startsWith("/project/")), false,
    "project-local destination settings must not receive either caller's request");
  assert.equal(received[0].authorization, undefined);
  assert.equal(received[1].authorization, undefined);

  console.log("PASS cross-caller journey: /so settings saved one user catalog; packaged CLI and real Pi used the same scripted endpoint");
} finally {
  if (piProvider) await piProvider.close();
  await new Promise((resolve) => {
    decisionServer.close(() => resolve());
    decisionServer.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
}

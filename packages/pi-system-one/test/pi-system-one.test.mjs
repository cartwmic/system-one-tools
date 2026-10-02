import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  getCustomGuidancePath,
  getSystemOneApi,
  saveCustomGuidance,
  saveSystemOnePreferences,
} from "../src/internal.js";

async function loadPiRuntime() {
  const override = process.env.PI_CODING_AGENT_PACKAGE_ROOT;
  let packageRoot = override;
  if (!packageRoot) {
    const command = process.platform === "win32" ? "where" : "which";
    const piBin = execFileSync(command, ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    const entry = await realpath(piBin);
    packageRoot = resolve(dirname(entry), "../..");
  }
  const root = resolve(packageRoot);
  const moduleUrl = (path) => pathToFileURL(join(root, path)).href;
  const pi = await import(moduleUrl("dist/index.js"));
  const extensions = await import(moduleUrl("dist/core/extensions/index.js"));
  const loader = await import(moduleUrl("dist/core/extensions/loader.js"));
  const { createEventBus } = await import(moduleUrl("dist/core/event-bus.js"));
  const { SessionManager } = await import(moduleUrl("dist/core/session-manager.js"));
  return { ...pi, ...extensions, ...loader, createEventBus, SessionManager };
}

const piRuntime = await loadPiRuntime();
const extensionPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
async function loadHarness(cwd, sessionManager, activeTools = ["read", "bash", "other_tool"], eventBus = piRuntime.createEventBus()) {
  piRuntime.clearExtensionCache();
  const runtime = piRuntime.createExtensionRuntime();
  const loaded = await piRuntime.loadExtensions([extensionPath], cwd, eventBus, runtime);
  assert.deepEqual(loaded.errors, [], "Pi's real extension loader should load the packaged entry");
  const runner = new piRuntime.ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, {});
  const active = [...activeTools];
  const messages = [];
  runner.bindCore({
    sendMessage: (...args) => { messages.push({ kind: "message", args }); },
    sendUserMessage: (...args) => { messages.push({ kind: "user", args }); },
    appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    getActiveTools: () => [...active],
    getAllTools: () => runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      promptGuidelines: definition.promptGuidelines,
      sourceInfo,
    })),
    setActiveTools: (names) => { active.splice(0, active.length, ...names); },
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
    getSystemPromptOptions: () => ({ cwd, sections: {} }),
  });
  return { runner, eventBus, active, loaded, messages };
}

async function emitSessionStart(runner, reason) {
  await runner.emit({ type: "session_start", reason });
}

async function emitPrompt(runner, cwd) {
  return runner.emitBeforeAgentStart("Evaluate the evidence supplied in this turn.", undefined, { cwd, sections: {} });
}

function toolDefinition(runner) {
  const tool = runner.getToolDefinition("system_one");
  assert.ok(tool, "system_one should be registered by the extension loader");
  return tool;
}

async function startScriptedPiProvider(extraQuestions = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const previousToolResult = body.messages?.some((message) => message.role === "tool");
    const offeredSystemOne = body.tools?.some((tool) => tool.function?.name === "system_one") ?? false;
    const shouldCallTool = offeredSystemOne && !previousToolResult;
    const toolCall = {
      id: "call_system_one_1",
      type: "function",
      function: {
        name: "system_one",
        arguments: JSON.stringify({
          state: { evidence: "The project note says release is blocked by a failing check." },
          questions: {
            ...extraQuestions,
            release: {
              type: "choice",
              instructions: "Which release decision is better supported?",
              criteria: { wait: "Wait for the failing check to be fixed", proceed: "Proceed now" },
            },
          },
        }),
      },
    };
    const firstChunk = shouldCallTool
      ? { role: "assistant", tool_calls: [toolCall] }
      : { role: "assistant", content: previousToolResult ? "The scripted judgment supports waiting for the failing check." : "Pi completed without invoking System One." };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-scripted",
      object: "chat.completion.chunk",
      created: 1,
      model: "scripted-pi-model",
      choices: [{ index: 0, delta: firstChunk, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-scripted",
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
  const address = server.address();
  return {
    requests,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function findPiExecutable() {
  const command = process.platform === "win32" ? "where" : "which";
  return execFileSync(command, ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
}

async function withAgentEnvironment(values, run) {
  const keys = ["HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await run();
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

const PREFERENCES = (agentAccess, defaultMode = "selective") => ({ version: 1, agentAccess, defaultMode });

await test("user-global default-on and default prompt mode are applied by the real Pi loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-default-on-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  let harness;
  try {
    await mkdir(cwd, { recursive: true });
    await withAgentEnvironment({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PI_CODING_AGENT_DIR: agentDir }, async () => {
      await saveSystemOnePreferences(PREFERENCES(true, "proactive"));
      const sessionManager = piRuntime.SessionManager.inMemory(cwd);
      harness = await loadHarness(cwd, sessionManager);
      await emitSessionStart(harness.runner, "startup");
      const status = await getSystemOneApi({ events: harness.eventBus }).getStatus(harness.runner.createContext());
      assert.equal(status.agentAccess, true);
      assert.equal(status.defaultAgentAccess, true);
      assert.equal(status.mode, "proactive");
      assert.ok(harness.active.includes("system_one"));
      assert.deepEqual(harness.active.filter((name) => name !== "system_one"), ["read", "bash", "other_tool"]);
      const prompt = await emitPrompt(harness.runner, cwd);
      assert.match(prompt.systemPromptOptions.sections["system-one-agent-usage"], /Usage mode: proactive/);
    });
  } finally {
    harness?.runner.invalidate("test finished");
    await rm(root, { recursive: true, force: true });
  }
});

await test("native preferences and branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "so-native-prefs-"));
  try {
    await withAgentEnvironment({ HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, async () => {
      const selection = { provider: "typesafe", id: "jev-latest" };
      await saveSystemOnePreferences({ ...PREFERENCES(true, "custom"), defaultClassifier: selection });
      const manager = piRuntime.SessionManager.inMemory(root);
      const harness = await loadHarness(root, manager);
      const ctx = { modelRegistry: {
        getModelOfType: (_type, provider, id) => ({ provider, id }),
        getAvailableOfType: async () => [{ ...selection }],
      } };
      try {
        await emitSessionStart(harness.runner, "startup");
        const api = getSystemOneApi({ events: harness.eventBus });
        assert.deepEqual((await api.getStatus(ctx)).classifier, selection);
        await api.setSessionUse({ provider: "other", id: "explicit" }, ctx);
        await emitSessionStart(harness.runner, "reload");
        assert.equal((await api.getStatus(ctx)).sessionClassifier.id, "explicit");
        assert.equal((await api.getStatus(ctx)).classifierAvailable, false);
        await emitSessionStart(harness.runner, "new");
        assert.equal((await api.getStatus(ctx)).sessionClassifier, null);
        const request = { state: { text: "blue" }, questions: { color: { type: "bool", instructions: "Blue?", criteria: { true: "blue", false: "not blue" } } } };
        await api.setSessionAccess(false);
        let calls = 0;
        const freshCtx = { modelRegistry: {
          getModelOfType: () => ({ provider: "fresh", id: "fresh" }),
          classify: async (_model, received, options) => {
            calls++;
            assert.deepEqual(received, request);
            assert.equal(options.maxRetries, 2);
            assert.ok(options.signal instanceof AbortSignal);
            return { stopReason: "aborted", answers: { mustNotLeak: {} }, usage: { totalTokens: 9 } };
          },
        } };
        await assert.rejects(toolDefinition(harness.runner).execute("off", request, undefined, undefined, freshCtx), /agent access is off/);
        const manual = await api.evaluateManual(request, {}, freshCtx);
        assert.equal(calls, 1, "manual uses the current per-call registry even with agent access off");
        assert.equal(manual.result.stopReason, "aborted");
        assert.equal(manual.result.answers, undefined);
        assert.equal(manual.result.usage.totalTokens, 9);
        await assert.rejects(api.evaluateManual(request, {}, { modelRegistry: { getModelOfType: () => undefined } }), /unavailable/);
        await saveSystemOnePreferences(PREFERENCES(false, "selective"));
        await assert.rejects(api.evaluateManual(request, {}, freshCtx), /No System One classifier/);
        await saveSystemOnePreferences({ ...PREFERENCES(true, "custom"), defaultClassifier: selection });
        await api.setSessionAccess(true);
        await assert.rejects(toolDefinition(harness.runner).execute("custom", request, undefined, undefined, freshCtx), /Custom mode requires/);
        await api.setSessionUse(selection, ctx);
        await api.restoreDefaults();
        assert.equal((await api.getStatus(ctx)).sessionClassifier, null);
        await assert.rejects(api.evaluateManual({ state: "old", questions: {} }, {}, ctx), /object state/);
        await assert.rejects(api.evaluateManual({ state: {}, questions: { x: { type: "boolean", instructions: "x" } } }, {}, ctx), /Invalid native/);
        await assert.rejects(api.evaluateManual({ state: {}, questions: {} }, { model: "agent" }, ctx), /owner classifier/);
      } finally { harness.runner.invalidate("test finished"); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test("native classifier agent contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "so-native-agent-"));
  const chat = await startScriptedPiProvider({
    blue: { type: "bool", instructions: "Is blue supported?", criteria: { true: "blue", false: "not blue" } },
    strength: { type: "score", instructions: "Rate strength", criteria: ["low", "medium", "high"] },
  });
  const requests = [];
  let behavior = "success";
  let attempt = 0;
  const native = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.headers.authorization, "Bearer dummy-native");
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/systemone");
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    assert.equal(body.model, "classifier-only");
    assert.deepEqual(Object.keys(body.questions).sort(), ["blue", "release", "strength"]);
    assert.equal(body.questions.blue.type, "noul");
    assert.equal(body.questions.strength.type, "score");
    requests.push({ url: req.url, body, time: Date.now() });
    attempt++;
    if (behavior === "auth" || behavior === "terminal" || (behavior === "transient" && attempt < 3)) {
      res.writeHead(behavior === "auth" ? 401 : 503, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: "scripted refusal" }));
      return;
    }
    if (behavior === "body-delay") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"answers":');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: behavior === "protocol" ? {} : { blue: { type: "noul", noul: 0.85 }, strength: { type: "score", score: 2, confidence: 0.8 }, release: { type: "choice", choice: "wait", probabilities: { wait: 0.9, proceed: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 17, output_tokens: 3 } }));
  });
  await new Promise((resolve) => native.listen(0, "127.0.0.1", resolve));
  const agentDir = join(root, "agent");
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", NATIVE_TEST_KEY: "dummy-native" };
  try {
    await mkdir(agentDir, { recursive: true });
    await saveSystemOnePreferences({ ...PREFERENCES(true, "selective"), defaultClassifier: { provider: "openrouter", id: "classifier-only" } }, env);
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      scripted: { baseUrl: `${chat.origin}/api/v1`, api: "openai-completions", apiKey: "dummy-chat", models: [{ id: "chat-only", name: "Chat only", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] },
      "openrouter": { baseUrl: `http://127.0.0.1:${native.address().port}/api/v1`, api: "typesafe-system-one", apiKey: "$NATIVE_TEST_KEY", models: [{ type: "classifier", id: "classifier-only", name: "Native only", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] },
    } }));
    const nativeExtension = join(root, "native-provider.mjs");
    await writeFile(nativeExtension, `import { classify } from ${JSON.stringify(pathToFileURL(join(process.env.PI_CODING_AGENT_PACKAGE_ROOT || resolve(dirname(await realpath(findPiExecutable())), "../.."), "node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one.js")).href)}; const originalFetch = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Scripted proof refuses non-loopback transport"); return originalFetch(input, options); }; export default function(pi) { pi.registerProvider("openrouter", { classifiers: { "typesafe-system-one": { classify } }, ...${JSON.stringify({ baseUrl: `http://127.0.0.1:${native.address().port}/api/v1`, api: "typesafe-system-one", apiKey: "$NATIVE_TEST_KEY", models: [{ type: "classifier", api: "typesafe-system-one", id: "classifier-only", name: "Native only", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] })}}); }`);
    async function turn() {
      const child = spawn(findPiExecutable(), ["--mode", "rpc", "--no-session", "--provider", "scripted", "--model", "chat-only", "--extension", nativeExtension, "--extension", extensionPath, "--approve"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "", buffer = "";
      const events = [];
      let finish, fail;
      const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const timeout = setTimeout(() => fail(new Error(`RPC timed out: ${stderr}`)), 45_000);
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", fail);
      child.on("exit", (code) => { if (code) fail(new Error(stderr)); });
      child.stdout.on("data", (data) => {
        buffer += data;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let event; try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          if (event.type === "agent_end") child.stdin.write(JSON.stringify({ id: "stats", type: "get_session_stats" }) + "\n");
          if (event.id === "stats") finish(event);
        }
      });
      child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Judge the release evidence using System One." }) + "\n");
      try { const stats = await done; return { stats, events }; }
      finally { clearTimeout(timeout); child.kill(); await new Promise((resolve) => child.once("close", resolve)); }
    }
    const success = await turn();
    assert.equal(success.stats.success, true);
    assert.equal(success.stats.data.tokens.total, 20, `native usage must enter actual Pi totals: ${JSON.stringify(success.events.filter(e => e.type === "tool_execution_end" || (e.type === "message_end" && e.message?.role === "assistant")))} requests=${JSON.stringify(requests)}`);
    assert.equal(success.stats.data.toolResults, 1);
    assert.ok(Math.abs(success.stats.data.cost - 0.000023) < 1e-12, "native catalog pricing enters actual Pi cost totals");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/v1/systemone");
    assert.equal(requests[0].body.model, "classifier-only");
    assert.deepEqual(Object.keys(requests[0].body).sort(), ["model", "questions", "state"]);
    assert.equal(JSON.parse(chat.requests.at(-1).body.messages.find(m => m.role === "tool").content).result.answers.release.choice, "wait");
    assert.match(JSON.stringify(success.events), /scripted judgment supports waiting/);
    behavior = "protocol"; attempt = 0;
    const failure = await turn();
    assert.equal(failure.stats.data.tokens.total, 20, "billed protocol failure usage must also enter actual totals");
    const followup = JSON.stringify(chat.requests.at(-1).body.messages);
    assert.match(followup, /Native classifier evaluation failed/);
    assert.equal(JSON.parse(chat.requests.at(-1).body.messages.find(m => m.role === "tool").content).result.answers, undefined);
    assert.equal(requests.length, 2, "protocol errors must not be retried by the extension");
    const successfulAnswers = JSON.parse(chat.requests[1].body.messages.find(m => m.role === "tool").content).result.answers;
    assert.equal(successfulAnswers.blue.type, "bool");
    assert.equal(successfulAnswers.blue.probability, 0.85);
    assert.equal(successfulAnswers.strength.score, 2);
    for (const [mode, expected, usable] of [["transient", 3, true], ["terminal", 3, false], ["auth", 1, false], ["body-delay", 1, false]]) {
      behavior = mode; attempt = 0;
      const before = requests.length;
      const started = Date.now();
      const outcome = await turn();
      const elapsed = Date.now() - started;
      assert.equal(outcome.stats.success, true, `${mode} must finish an actual agent turn`);
      assert.equal(requests.length - before, expected, `${mode} per-operation attempt count`);
      const payload = JSON.parse(chat.requests.at(-1).body.messages.find(m => m.role === "tool").content);
      assert.equal(Boolean(payload.result?.answers), usable, `${mode} failed answers unusable`);
      if (mode === "body-delay") assert.ok(elapsed >= 29_000 && elapsed < 40_000, `single deadline including response body: ${elapsed}ms`);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(requests.length - before, expected, `${mode} no post-terminal transport`);
      console.log(JSON.stringify({ nativeCase: mode, attempts: expected, elapsedMs: elapsed, completed: true }));
    }
    const beforeMissingAuth = requests.length;
    delete env.NATIVE_TEST_KEY;
    const unauthenticated = await turn();
    assert.equal(unauthenticated.stats.data.tokens.total, 0);
    assert.equal(requests.length, beforeMissingAuth, "missing native auth must refuse before transport");
    assert.match(JSON.stringify(chat.requests.at(-1).body.messages), /Native classifier evaluation failed/);
  } finally {
    await Promise.all([chat.close(), new Promise((resolve) => { native.close(resolve); native.closeAllConnections(); })]);
    await rm(root, { recursive: true, force: true });
  }
});

await test("native controller lifecycle modes validation and accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-controller-migration-"));
  try {
    await withAgentEnvironment({ HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, async () => {
      const first = { provider: "native", id: "first" };
      const second = { provider: "native", id: "second" };
      await saveSystemOnePreferences({ ...PREFERENCES(false), defaultClassifier: first });
      const manager = piRuntime.SessionManager.inMemory(root);
      const harness = await loadHarness(root, manager);
      const api = getSystemOneApi({ events: harness.eventBus });
      const calls = [];
      let result = { stopReason: "stop", answers: { x: { type: "bool", probability: 0.8 } }, usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0.01 } } };
      const ctx = { modelRegistry: {
        getModelOfType: (type, provider, id) => {
          assert.equal(type, "classifier");
          return [first, second].find((model) => model.provider === provider && model.id === id);
        },
        getAvailableOfType: async () => [first, second],
        classify: async (model, request, options) => { calls.push({ model, request, options }); return result; },
      } };
      const request = { state: { evidence: "blue" }, questions: { x: { type: "bool", instructions: "Blue?", criteria: { true: "blue", false: "not blue" } } } };
      const tool = toolDefinition(harness.runner);
      try {
        await emitSessionStart(harness.runner, "startup");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["state", "questions"]);
        assert.equal(tool.parameters.additionalProperties, false);
        await api.setSessionUse(second, ctx);
        await api.setSessionAccess(true);
        await api.setSessionMode("explicit");
        for (const reason of ["reload", "resume"]) {
          await emitSessionStart(harness.runner, reason);
          const status = await api.getStatus(ctx);
          assert.deepEqual(status.classifier, second);
          assert.equal(status.agentAccess, true);
          assert.equal(status.mode, "explicit");
        }
        const selectedEntry = manager.getLeafId();
        await api.setSessionUse(first, ctx);
        await api.setSessionAccess(false);
        manager.branch(selectedEntry);
        await harness.runner.emit({ type: "session_tree" });
        assert.deepEqual((await api.getStatus(ctx)).classifier, second);
        assert.equal((await api.getStatus(ctx)).agentAccess, true);
        for (const [mode, wording] of [["explicit", /only when the user names/], ["selective", /bounded intermediate judgment/], ["proactive", /more eligible bounded/]]) {
          await api.setSessionMode(mode);
          const prompt = (await emitPrompt(harness.runner, root)).systemPromptOptions.sections["system-one-agent-usage"];
          assert.match(prompt, wording);
          assert.match(prompt, /never attach conversation history/);
          assert.match(prompt, /do not authorize, perform, or justify an action/);
          assert.match(prompt, /factual retrieval, exact calculations/);
        }
        await api.setSessionMode("custom");
        for (const preparation of [async () => {}, async () => saveCustomGuidance("  "), async () => {
          await rm(getCustomGuidancePath(), { force: true });
          await mkdir(getCustomGuidancePath(), { recursive: true });
        }]) {
          await preparation();
          await emitPrompt(harness.runner, root);
          assert.equal(harness.active.includes("system_one"), false, "blocked Custom hides the active offer");
          await assert.rejects(tool.execute("custom", request, undefined, undefined, ctx), /Custom mode requires/);
        }
        assert.equal(calls.length, 0);
        await rm(getCustomGuidancePath(), { recursive: true });
        await saveCustomGuidance("Owner custom instruction");
        const prompt = (await emitPrompt(harness.runner, root)).systemPromptOptions.sections["system-one-agent-usage"];
        assert.equal(harness.active.includes("system_one"), true, "valid Custom restores the active offer on the next turn");
        assert.match(prompt, /Owner custom instruction/);
        assert.match(prompt, /Fixed boundary:/);
        const success = await tool.execute("success", request, undefined, undefined, ctx);
        assert.deepEqual(success.usage, result.usage);
        assert.deepEqual(success.details.result.answers, result.answers);
        assert.deepEqual(calls[0].model, second);
        assert.deepEqual(calls[0].request, request);
        assert.equal(calls[0].options.maxRetries, 2);
        assert.ok(calls[0].options.signal instanceof AbortSignal);
        result = { stopReason: "error", answers: { secret: "not usable" }, errorMessage: "provider private error", usage: result.usage };
        const failure = await tool.execute("billed-error", request, undefined, undefined, ctx);
        assert.equal(failure.isError, true);
        assert.deepEqual(failure.usage, result.usage);
        assert.equal(failure.details.result.answers, undefined);
        assert.doesNotMatch(JSON.stringify(failure), /not usable|provider private error/);
        const before = JSON.stringify(manager.getBranch());
        await api.evaluateManual(request, { classifier: first }, ctx);
        assert.deepEqual(calls.at(-1).model, first);
        assert.equal(JSON.stringify(manager.getBranch()), before);
        assert.deepEqual(harness.messages, []);
        assert.deepEqual((await api.getStatus(ctx)).classifier, second);
        const count = calls.length;
        for (const invalid of [
          { ...request, model: "agent-selected" }, { ...request, state: "legacy" },
          { ...request, questions: {} },
          { ...request, questions: { x: { ...request.questions.x, type: "boolean" } } },
          { ...request, questions: { x: { ...request.questions.x, criteria: { true: "yes" } } } },
          { ...request, questions: { x: { ...request.questions.x, extra: true } } },
        ]) await assert.rejects(api.evaluateManual(invalid, {}, ctx), TypeError);
        const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(api.evaluateManual(request, { signal: cancelled.signal }, ctx), { name: "AbortError" });
        assert.equal(calls.length, count);
        await assert.rejects(api.setSessionUse("old-catalog-id", ctx), /provider and id/);
        await assert.rejects(api.setSessionUse({ provider: "missing", id: "missing" }, ctx), /unavailable/);
        await api.restoreDefaults();
        assert.equal((await api.getStatus(ctx)).sessionAgentAccess, null);
        assert.deepEqual((await api.getStatus(ctx)).classifier, first);
        assert.deepEqual(harness.active, ["read", "bash", "other_tool"]);
        await api.setSessionUse(second, ctx);
        await emitSessionStart(harness.runner, "new");
        assert.deepEqual((await api.getStatus(ctx)).classifier, first);
        assert.equal((await api.getStatus(ctx)).sessionMode, null);
      } finally { harness.runner.invalidate("test finished"); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test("native caller bounds", { timeout: 240_000 }, async () => {
  const { nativeCallerBounds } = await import("../../../scripts/native-caller-bounds.mjs");
  const proof = await nativeCallerBounds();
  assert.equal(proof.outcomes.length, 12);
  assert.ok(proof.outcomes.every(outcome => outcome.completed && outcome.noLaterRequests));
});

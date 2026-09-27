import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  getDefaultCatalogPath,
  loadConnectionCatalog,
  writeConnectionCatalog,
} from "@cartwmic/system-one-connections";
import {
  getCustomGuidancePath,
  getSystemOneApi,
  getSystemOnePreferencesPath,
  loadSystemOnePreferences,
  saveSystemOnePreferences,
} from "../src/internal.js";

async function loadPiRuntime() {
  const override = process.env.PI_CODING_AGENT_PACKAGE_ROOT;
  let packageRoot = override;
  if (!packageRoot) {
    const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
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
const agentExtensionPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const request = {
  state: { evidence: "The owner supplied a bounded evidence sample." },
  questions: {
    choice: {
      type: "choice",
      instructions: "Which option is better supported?",
      criteria: { first: "First option", second: "Second option" },
    },
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function startDecisionServer({ holdFirst = false } = {}) {
  const received = [];
  const firstRequest = deferred();
  const releaseFirst = deferred();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ url: req.url, authorization: req.headers.authorization, body });
    if (received.length === 1) firstRequest.resolve(received[0]);
    if (holdFirst && received.length === 1) await releaseFirst.promise;

    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
      if (question.type === "choice") {
        const choice = Object.keys(question.criteria)[0];
        answers[name] = {
          type: "choice",
          choice,
          probabilities: { [choice]: 0.8, [Object.keys(question.criteria)[1]]: 0.2 },
        };
      } else if (question.type === "noul") {
        answers[name] = { type: "noul", noul: 0.75 };
      } else {
        answers[name] = { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 } };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "scripted-resolved-model", answers, usage: { input_tokens: 13, output_tokens: 5 } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    received,
    origin: `http://127.0.0.1:${address.port}`,
    firstRequest: firstRequest.promise,
    releaseFirst: () => releaseFirst.resolve(),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function loadHarness(cwd, sessionManager, eventBus = piRuntime.createEventBus()) {
  piRuntime.clearExtensionCache();
  const runtime = piRuntime.createExtensionRuntime();
  const loaded = await piRuntime.loadExtensions([agentExtensionPath], cwd, eventBus, runtime);
  assert.deepEqual(loaded.errors, [], "Pi's real extension loader should load the single integrated package entry");
  const runner = new piRuntime.ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, {});
  const active = ["read", "bash", "other_tool"];
  runner.bindCore({
    sendMessage() {},
    sendUserMessage() {},
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
  return { runner, eventBus, active, loaded };
}

function scriptedUi({ selects = [], inputs = [], editors = [] } = {}) {
  const calls = { selects: [], inputs: [], editors: [], notifications: [] };
  return {
    calls,
    async select(title, options) {
      calls.selects.push({ title, options: [...options] });
      assert.ok(selects.length > 0, `Unexpected Pi select prompt: ${title}`);
      const answer = selects.shift();
      assert.ok(options.includes(answer), `Selection ${JSON.stringify(answer)} not offered by ${title}: ${options.join(", ")}`);
      return answer;
    },
    async input(title, placeholder) {
      calls.inputs.push({ title, placeholder });
      assert.ok(inputs.length > 0, `Unexpected Pi input prompt: ${title}`);
      return inputs.shift();
    },
    async editor(title, prefill) {
      calls.editors.push({ title, prefill });
      assert.ok(editors.length > 0, `Unexpected Pi editor prompt: ${title}`);
      return editors.shift();
    },
    notify(message, type = "info") {
      calls.notifications.push({ message, type });
    },
  };
}

function commandContext(runner, ui) {
  const context = Object.create(runner.createContext());
  Object.defineProperty(context, "ui", { value: ui, configurable: true });
  return context;
}

function plainTerminal(text) {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\s+/g, " ");
}

function soCommand(runner) {
  const command = runner.getRegisteredCommands().find((entry) => entry.name === "so");
  assert.ok(command, "the Pi System One extension should register one /so command");
  assert.equal(runner.getRegisteredCommands().filter((entry) => entry.name === "so").length, 1);
  return command;
}

async function installPackedConsumer(root) {
  const tarballs = join(root, "tarballs");
  const consumer = join(root, "consumer");
  await mkdir(tarballs, { recursive: true });
  await mkdir(consumer, { recursive: true });
  for (const workspace of [
    "@cartwmic/system-one-connections",
    "@cartwmic/pi-system-one",
  ]) {
    execFileSync("npm", ["pack", "--workspace", workspace, "--pack-destination", tarballs], {
      cwd: workspaceRoot,
      stdio: "ignore",
    });
  }
  const files = await readdir(tarballs);
  execFileSync("npm", ["install", "--prefix", consumer, "--no-save", "--ignore-scripts", "--offline", ...files.map((file) => join(tarballs, file))], {
    cwd: workspaceRoot,
    stdio: "ignore",
  });
  return consumer;
}

async function withEnvironment(values, run) {
  const keys = ["HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_PACKAGE_ROOT"];
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

const preferences = (agentAccess = false, defaultMode = "selective") => ({
  version: 1,
  agentAccess,
  defaultMode,
});

async function prepareUserFiles(root, agentDir, catalog) {
  await mkdir(root, { recursive: true });
  await saveSystemOnePreferences(preferences(), { HOME: root, PI_CODING_AGENT_DIR: agentDir });
  await writeConnectionCatalog(catalog, join(root, "xdg", "system-one", "connections.json"));
}

async function runSo(harness, args, ui) {
  await soCommand(harness.runner).handler(args, commandContext(harness.runner, ui));
}

await test("the registered /so dispatcher owns session controls, direct ask, and persistent settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-ui-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const server = await startDecisionServer();
  let harness;
  try {
    await prepareUserFiles(root, agentDir, {
      version: 1,
      default: "owner",
      connections: {
        owner: { baseURL: `${server.origin}/owner/v1`, model: "owner-model" },
        other: { baseURL: `${server.origin}/other/v1`, model: "other-model" },
        locked: { baseURL: `${server.origin}/locked/v1`, model: "locked-model", apiKeyEnv: "SYSTEM_ONE_UI_TEST_KEY_MISSING" },
      },
    });
    const sessionManager = piRuntime.SessionManager.inMemory(cwd);
    await withEnvironment({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PI_CODING_AGENT_DIR: agentDir }, async () => {
      harness = await loadHarness(cwd, sessionManager);
      await harness.runner.emit({ type: "session_start", reason: "startup" });
      const api = getSystemOneApi({ events: harness.eventBus });

      const statusUi = scriptedUi();
      await runSo(harness, "status", statusUi);
      assert.match(statusUi.calls.notifications[0].message, /Agent access: off/);
      assert.match(statusUi.calls.notifications[0].message, /Connection: owner \(available\)/);

      await runSo(harness, "on", scriptedUi());
      assert.ok(harness.active.includes("system_one"));
      assert.equal((await api.getStatus()).sessionAgentAccess, true);
      const agentTool = harness.runner.getToolDefinition("system_one");
      const enabledResult = await agentTool.execute("owner-on", request, undefined, undefined, harness.runner.createContext());
      assert.equal(enabledResult.details.connectionId, "owner", "/so on must enable a later agent call through the selected catalog default");
      assert.equal(server.received.length, 1);
      assert.equal(server.received[0].url, "/owner/v1/systemone");

      await runSo(harness, "off", scriptedUi());
      assert.ok(!harness.active.includes("system_one"));
      assert.equal((await api.getStatus()).agentAccess, false);
      await assert.rejects(
        agentTool.execute("owner-off", request, undefined, undefined, harness.runner.createContext()),
        /access is off/i,
      );
      assert.equal(server.received.length, 1, "/so off must block later agent calls before HTTP");

      await runSo(harness, "use other", scriptedUi());
      await runSo(harness, "mode proactive", scriptedUi());
      let status = await api.getStatus();
      assert.equal(status.activeConnectionId, "other");
      assert.equal(status.sessionConnectionId, "other");
      assert.equal(status.mode, "proactive");
      assert.equal(status.sessionMode, "proactive");
      const modePrompt = await harness.runner.emitBeforeAgentStart("Use the current owner-selected mode.", undefined, { cwd, sections: {} });
      assert.match(modePrompt.systemPromptOptions.sections["system-one-agent-usage"], /Usage mode: proactive/);
      const statusAfterControls = scriptedUi();
      await runSo(harness, "status", statusAfterControls);
      assert.match(statusAfterControls.calls.notifications[0].message, /Connection: other \(available\) \(session override\)/);
      assert.match(statusAfterControls.calls.notifications[0].message, /Prompt mode: Proactive \(session override/);
      await runSo(harness, "on", scriptedUi());
      const selectedResult = await agentTool.execute("owner-use", request, undefined, undefined, harness.runner.createContext());
      assert.equal(selectedResult.details.connectionId, "other", "/so use must affect later agent calls");
      assert.equal(server.received[1].url, "/other/v1/systemone");
      assert.equal(server.received[1].body.model, "other-model");
      await runSo(harness, "off", scriptedUi());

      await runSo(harness, "use", scriptedUi({ selects: ["Catalog default"] }));
      await runSo(harness, "mode", scriptedUi({ selects: ["Custom"] }));
      assert.equal((await api.getStatus()).sessionConnectionId, null);
      assert.equal((await api.getStatus()).sessionMode, "custom");
      await runSo(harness, "reset", scriptedUi());
      assert.equal((await api.getStatus()).mode, "selective");
      assert.equal((await api.getStatus()).agentAccess, false);

      const branchBeforeManual = sessionManager.getBranch().length;
      const manualUi = scriptedUi({
        editors: [JSON.stringify(request), undefined],
        selects: ["other"],
        inputs: ["one-call-model"],
      });
      await runSo(harness, "ask", manualUi);
      assert.equal(server.received.length, 3, "manual evaluation must work while agent access is off");
      assert.equal(server.received[2].url, "/other/v1/systemone");
      assert.equal(server.received[2].body.model, "one-call-model");
      assert.deepEqual(server.received[2].body.state, request.state);
      assert.match(manualUi.calls.editors[1].title, /terminal only/);
      assert.match(manualUi.calls.editors[1].prefill, /scripted-resolved-model/);
      assert.equal(sessionManager.getBranch().length, branchBeforeManual, "manual request/result must not enter session or agent context");
      assert.equal((await api.getStatus()).activeConnectionId, "owner", "the one-call controls must not alter session use");

      const missingKeyUi = scriptedUi({
        editors: [JSON.stringify(request)],
        selects: ["locked"],
        inputs: [""],
      });
      await runSo(harness, "ask", missingKeyUi);
      assert.equal(server.received.length, 3, "missing credentials fail before an HTTP request");
      assert.equal(missingKeyUi.calls.notifications[0].type, "error");
      assert.match(missingKeyUi.calls.notifications[0].message, /SYSTEM_ONE_UI_TEST_KEY_MISSING/);
      assert.equal(missingKeyUi.calls.editors.length, 1, "failures must not be shown as a result");

      await runSo(harness, "off", scriptedUi());
      await runSo(harness, "settings", scriptedUi({
        selects: ["Manage connections", "owner"],
        inputs: [`${server.origin}/edited/v1`, "edited-model", ""],
      }));
      await runSo(harness, "settings", scriptedUi({
        selects: ["Manage connections", "Create a connection"],
        inputs: ["later", `${server.origin}/later/v1`, "later-model", ""],
      }));
      await runSo(harness, "settings", scriptedUi({
        selects: ["Set catalog default connection", "later"],
      }));
      await runSo(harness, "settings", scriptedUi({
        selects: ["Set persistent agent defaults", "On", "Proactive"],
      }));
      await runSo(harness, "settings", scriptedUi({
        selects: ["Edit custom guidance"],
        editors: ["Ask one bounded question over supplied evidence."],
      }));

      const catalog = await loadConnectionCatalog(getDefaultCatalogPath(process.env));
      assert.equal(catalog.default, "later");
      assert.deepEqual(catalog.connections.owner, {
        baseURL: `${server.origin}/edited/v1`,
        model: "edited-model",
      });
      assert.equal(catalog.connections.later.model, "later-model");
      assert.deepEqual(await loadSystemOnePreferences(process.env), preferences(true, "proactive"));
      assert.equal(await readFile(getCustomGuidancePath(process.env), "utf8"), "Ask one bounded question over supplied evidence.");
      assert.equal(await readFile(getSystemOnePreferencesPath(process.env), "utf8").then((text) => JSON.parse(text).agentAccess), true);

      await runSo(harness, "status", scriptedUi());
      assert.equal((await api.getStatus()).defaultAgentAccess, true);
      assert.equal((await api.getStatus()).defaultMode, "proactive");
      assert.equal((await api.getStatus()).activeConnectionId, "later", "saved catalog defaults must affect later calls");
      assert.equal((await api.getStatus()).agentAccess, false, "persistent changes must not erase a session-only off override");
      await runSo(harness, "reset", scriptedUi());
      assert.equal((await api.getStatus()).agentAccess, true);
      assert.equal((await api.getStatus()).mode, "proactive");
      const savedPrompt = await harness.runner.emitBeforeAgentStart("Continue using saved owner defaults.", undefined, { cwd, sections: {} });
      assert.match(savedPrompt.systemPromptOptions.sections["system-one-agent-usage"], /Usage mode: proactive/);
      assert.match(savedPrompt.systemPromptOptions.sections["system-one-agent-usage"], /Consider more eligible bounded intermediate judgments/);
      const laterAgentResult = await agentTool.execute("saved-defaults", request, undefined, undefined, harness.runner.createContext());
      assert.equal(laterAgentResult.details.connectionId, "later");
      assert.equal(server.received.length, 4);
      assert.equal(server.received[3].url, "/later/v1/systemone");
      assert.equal(server.received[3].body.model, "later-model");
    });
  } finally {
    harness?.runner.invalidate("test finished");
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("editing the shared catalog does not redirect an in-flight call but affects the next one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-ui-snapshot-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const server = await startDecisionServer({ holdFirst: true });
  let harness;
  try {
    await prepareUserFiles(root, agentDir, {
      version: 1,
      default: "owner",
      connections: { owner: { baseURL: `${server.origin}/before/v1`, model: "before-model" } },
    });
    await withEnvironment({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), PI_CODING_AGENT_DIR: agentDir }, async () => {
      harness = await loadHarness(cwd, piRuntime.SessionManager.inMemory(cwd));
      await harness.runner.emit({ type: "session_start", reason: "startup" });
      const api = getSystemOneApi({ events: harness.eventBus });
      const pending = api.evaluateManual(request);
      const received = await server.firstRequest;
      assert.equal(received.url, "/before/v1/systemone");
      assert.equal(received.body.model, "before-model");

      await writeConnectionCatalog({
        version: 1,
        default: "owner",
        connections: { owner: { baseURL: `${server.origin}/after/v1`, model: "after-model" } },
      }, getDefaultCatalogPath(process.env));
      server.releaseFirst();
      await pending;
      const next = await api.evaluateManual(request);
      assert.equal(next.connectionId, "owner");
      assert.equal(server.received.length, 2);
      assert.equal(server.received[1].url, "/after/v1/systemone");
      assert.equal(server.received[1].body.model, "after-model");
    });
  } finally {
    harness?.runner.invalidate("test finished");
    server.releaseFirst();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function runInteractivePi(args, env, timeoutMs = 45_000) {
  const python = String.raw`
import errno, os, pty, select, signal, sys, time
command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, os.environ)
output = bytearray()
def wait_for(token, timeout=12):
    deadline = time.time() + timeout
    needle = token.encode() if isinstance(token, str) else token
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 8192)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not chunk: break
            output.extend(chunk)
            if needle in output: return
    raise RuntimeError("Timed out waiting for " + str(token) + "\n" + output.decode(errors="replace")[-6000:])
def send(data):
    os.write(fd, data)
def send_startup_command_until(token, command, timeout=20):
    send(command + b"\r")
    deadline = time.time() + timeout
    needle = token if isinstance(token, bytes) else token.encode()
    while needle not in output and time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 8192)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not chunk: break
            output.extend(chunk)
        if needle not in output:
            send(b"\r")
    if needle not in output:
        raise RuntimeError("Startup command did not complete: " + token.decode() + "\n" + output.decode(errors="replace")[-6000:])
try:
    wait_for(b"scripted-model")
    send_startup_command_until(b"access is on", b"/so on")
    send(b"/so use local\r")
    wait_for(b"connection set to local")
    send(b"/so mode proactive\r")
    wait_for(b"mode set to Proactive")
    send(b"/reload\r")
    wait_for(b"Reloaded keybindings, extensions")
    send(b"/so status\r")
    wait_for(b"Prompt mode: Proactive")
    send(b"/so off\r")
    wait_for(b"access is off")
    send(b"/so guidance\r")
    wait_for(b"Edit custom System One guidance")
    send(b"\x07")
    wait_for(b"Owner custom guidance from external editor")
    send(b"\r")
    wait_for(b"Saved user-global custom guidance")
    send(b"/so ask\r")
    wait_for(b"System One request JSON")
    send(b"\x07")
    wait_for(b"TUI manual")
    send(b"\r")
    wait_for(b"Connection for this call only")
    send(b"\r")
    wait_for(b"Model override for this call")
    send(b"\r")
    wait_for(b"System One result")
finally:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
sys.stdout.buffer.write(output)

`;
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", python, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout: stdout.toString("utf8"), stderr, timedOut });
    });
  });
}

await test("a real Pi TUI owner journey reloads state, asks manually while off, and uses Ctrl+G", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-ui-tui-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const xdg = join(root, "xdg");
  const server = await startDecisionServer();
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await saveSystemOnePreferences(preferences(false), { HOME: root, PI_CODING_AGENT_DIR: agentDir });
    await writeConnectionCatalog({
      version: 1,
      default: "local",
      connections: { local: { baseURL: `${server.origin}/tui/v1`, model: "tui-model" } },
    }, join(xdg, "system-one", "connections.json"));

    const externalEditor = join(root, "test-editor.sh");
    await writeFile(externalEditor, `#!/bin/sh\nif grep -q 'Replace this with relevant evidence' "$1"; then\n  printf '%s\\n' '{"state":{"evidence":"TUI manual evidence"},"questions":{"release":{"type":"choice","instructions":"Which option is supported?","criteria":{"wait":"Wait","proceed":"Proceed"}}}}' > "$1"\nelse\n  printf '%s\\n' 'Owner custom guidance from external editor.' > "$1"\nfi\n`);
    await chmod(externalEditor, 0o700);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      externalEditor,
      quietStartup: true,
    }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        scripted: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "$SCRIPTED_PI_API_KEY",
          models: [{
            id: "scripted-model",
            name: "Scripted no-call TUI model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 512,
          }],
        },
      },
    }));

    const consumer = await installPackedConsumer(root);
    const packagedAgentExtension = join(consumer, "node_modules", "@cartwmic", "pi-system-one", "src", "index.js");
    const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    const env = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: xdg,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TERM: "xterm-256color",
      SCRIPTED_PI_API_KEY: "unused-scripted-key",
    };
    const result = await runInteractivePi([
      piBin,
      "--no-session",
      "--no-extensions",
      "--provider", "scripted",
      "--model", "scripted-model",
      "--extension", packagedAgentExtension,
      "--tools", "system_one",
    ], env);
    assert.equal(result.timedOut, false, `Pi TUI timed out.\n${result.stdout.slice(-8000)}\n${result.stderr}`);
    assert.equal(result.status, 0, `Pi TUI failed (${result.signal}).\n${result.stdout.slice(-8000)}\n${result.stderr}`);
    const terminal = plainTerminal(result.stdout);
    assert.match(terminal, /Prompt mode: Proactive/, "session access, connection, and mode should survive actual /reload");
    assert.match(terminal, /TUI manual evidence/);
    assert.match(terminal, /System One result — terminal only/);
    assert.equal(server.received.length, 1, "the manual command should make exactly one backend call");
    assert.equal(server.received[0].url, "/tui/v1/systemone");
    assert.deepEqual(server.received[0].body.state, { evidence: "TUI manual evidence" });
    assert.equal(await loadSystemOnePreferences({ HOME: root, PI_CODING_AGENT_DIR: agentDir }).then((value) => value.agentAccess), false);
    assert.equal(await readFile(getCustomGuidancePath({ HOME: root, PI_CODING_AGENT_DIR: agentDir }), "utf8"),
      "Owner custom guidance from external editor.");
    assert.equal(server.received[0].authorization, undefined);
  } catch (error) {
    if (error?.code === "ENOENT" && error.path === "python3") {
      t.skip("Python 3 is required for the portable local Pi PTY scenario");
      return;
    }
    throw error;
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

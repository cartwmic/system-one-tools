import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  getDefaultCatalogPath,
  writeConnectionCatalog,
} from "@cartwmic/system-one-connections";
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
const request = {
  state: { evidence: "The user supplied this short evidence." },
  questions: {
    choice: {
      type: "choice",
      instructions: "Which option is better supported?",
      criteria: { yes: "Supported", no: "Not supported" },
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

async function startServer(echoCredential = false) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ url: req.url, authorization: req.headers.authorization, body });
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
      if (question.type === "choice") {
        const choice = Object.keys(question.criteria)[0];
        answers[name] = { type: "choice", choice, probabilities: { [choice]: 0.8, [Object.keys(question.criteria)[1]]: 0.2 } };
      } else if (question.type === "noul") {
        answers[name] = { type: "noul", noul: 0.72 };
      } else {
        answers[name] = { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 }, legend: { "0": "low", "1": "medium", "2": "high" } };
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    const credential = req.headers.authorization?.replace(/^Bearer /i, "");
    res.end(JSON.stringify({
      model: "scripted-resolved-model",
      answers,
      usage: { input_tokens: 21, output_tokens: 8 },
      ...(echoCredential ? { providerMetadata: { [`echo${credential}`]: credential, nested: [`Bearer ${credential}`] } } : {}),
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    received,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function loadHarness(cwd, sessionManager, activeTools = ["read", "bash", "other_tool"], eventBus = piRuntime.createEventBus()) {
  piRuntime.clearExtensionCache();
  const runtime = piRuntime.createExtensionRuntime();
  const loaded = await piRuntime.loadExtensions([extensionPath], cwd, eventBus, runtime);
  assert.deepEqual(loaded.errors, [], "Pi's real extension loader should load the packaged entry");
  const runner = new piRuntime.ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, {});
  const active = [...activeTools];
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

async function startScriptedPiProvider() {
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

function runPi(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(findPiExecutable(), args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: timedOut ? new Error(`Pi process timed out after ${options.timeoutMs}ms`) : undefined,
      });
    });
  });
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

await test("Pi loader tool, owner API, branch state, prompt modes, and scripted evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const configHome = join(root, "xdg");
  const fixture = await startServer();
  let harness;
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      systemOne: { agentAccess: true, defaultConnection: "project" },
    }));

    await withAgentEnvironment({ HOME: root, XDG_CONFIG_HOME: configHome, PI_CODING_AGENT_DIR: agentDir }, async () => {
      await saveSystemOnePreferences(PREFERENCES(false, "selective"));
      await writeConnectionCatalog({
        version: 1,
        default: "owner",
        connections: {
          owner: { baseURL: `${fixture.origin}/owner/v1`, model: "owner-model" },
          project: { baseURL: `${fixture.origin}/project/v1`, model: "project-model" },
        },
      }, getDefaultCatalogPath(process.env));

      const sessionManager = piRuntime.SessionManager.inMemory(cwd);
      harness = await loadHarness(cwd, sessionManager);
      await emitSessionStart(harness.runner, "startup");
      assert.deepEqual(harness.active, ["read", "bash", "other_tool"], "default-off must not alter other active tools");

      const tool = toolDefinition(harness.runner);
      assert.deepEqual(Object.keys(tool.parameters.properties), ["state", "questions"]);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.equal("connectionId" in tool.parameters.properties, false);
      assert.equal("model" in tool.parameters.properties, false);
      assert.match(tool.description, /never reads or attaches conversation history, files, or repository contents automatically/i);
      assert.match(tool.description, /factual retrieval, exact calculations, vague impressions, open-ended generation, or substantial multi-step reasoning/i);

      const api = getSystemOneApi({ events: harness.eventBus });
      let status = await api.getStatus();
      assert.equal(status.agentAccess, false, "the trusted project-local conflict must not enable the tool");
      assert.equal(status.activeConnectionId, "owner", "project-local connection settings must not redirect the owner catalog default");
      assert.equal(status.mode, "selective");
      const selectivePrompt = await emitPrompt(harness.runner, cwd);
      assert.match(selectivePrompt.systemPromptOptions.sections["system-one-agent-usage"], /Usage mode: selective/);
      assert.match(selectivePrompt.systemPromptOptions.sections["system-one-agent-usage"], /genuinely useful to move forward/);
      assert.equal("baseURL" in status, false);
      assert.equal("model" in status, false);
      assert.equal("apiKeyEnv" in status, false);
      await assert.rejects(
        tool.execute("disabled", request, undefined, undefined, harness.runner.createContext()),
        /access is off/i,
      );
      assert.equal(fixture.received.length, 0, "the call-time gate must fail before HTTP");

      const manual = await api.evaluateManual(request);
      assert.equal(manual.connectionId, "owner", "manual evaluation remains available while agent access is off");
      assert.equal(manual.model, "scripted-resolved-model");
      assert.equal(fixture.received[0].url, "/owner/v1/systemone");
      assert.deepEqual(Object.keys(fixture.received[0].body).sort(), ["model", "questions", "state"]);

      await api.setSessionAccess(true);
      const accessEntry = sessionManager.getBranch().at(-1);
      await api.setSessionUse("owner");
      await api.setSessionMode("proactive");
      assert.deepEqual(harness.active, ["read", "bash", "other_tool", "system_one"], "enabling must preserve every other active tool");

      const prompt = await emitPrompt(harness.runner, cwd);
      const section = prompt.systemPromptOptions.sections["system-one-agent-usage"];
      assert.match(section, /Usage mode: proactive/);
      assert.match(section, /Consider more eligible bounded intermediate judgments/);
      assert.match(section, /Do not use System One for factual retrieval/);

      const toolResult = await tool.execute("enabled", request, undefined, undefined, harness.runner.createContext());
      assert.equal(toolResult.details.connectionId, "owner");
      assert.equal(toolResult.details.model, "scripted-resolved-model");
      assert.deepEqual(fixture.received[1].body.state, request.state);
      assert.deepEqual(Object.keys(fixture.received[1].body).sort(), ["model", "questions", "state"]);
      assert.equal(fixture.received[1].body.model, "owner-model");
      assert.equal(fixture.received[1].url, "/owner/v1/systemone");
      assert.deepEqual(fixture.received[1].body.questions.boolean, {
        type: "noul",
        instructions: request.questions.boolean.instructions,
        criteria: request.questions.boolean.criteria,
      });
      assert.equal(toolResult.details.result.answers.choice.choice, "yes");
      assert.deepEqual(toolResult.details.result.answers.boolean, { type: "boolean", probability: 0.72 });
      assert.equal(toolResult.details.result.answers.score.score, 1);

      await api.setSessionMode("explicit");
      const explicitPrompt = await emitPrompt(harness.runner, cwd);
      assert.match(explicitPrompt.systemPromptOptions.sections["system-one-agent-usage"], /only when the user names System One or explicitly tells you/i);
      await api.setSessionMode("custom");
      const missingPrompt = await emitPrompt(harness.runner, cwd);
      assert.match(missingPrompt.systemPromptOptions.sections["system-one-agent-usage"], /Custom guidance is missing/i);
      await assert.rejects(
        tool.execute("missing-custom", request, undefined, undefined, harness.runner.createContext()),
        /Custom mode requires nonempty user-global guidance/i,
      );
      assert.equal(fixture.received.length, 2, "missing Custom guidance must block the agent call before HTTP");
      const customManual = await api.evaluateManual(request);
      assert.equal(customManual.connectionId, "owner", "manual evaluation must remain available when Custom guidance is missing");
      assert.equal(fixture.received.length, 3);

      const guidancePath = getCustomGuidancePath(process.env);
      await mkdir(guidancePath);
      const unreadablePrompt = await emitPrompt(harness.runner, cwd);
      assert.match(unreadablePrompt.systemPromptOptions.sections["system-one-agent-usage"], /Custom guidance is unreadable/i);
      await assert.rejects(
        tool.execute("unreadable-custom", request, undefined, undefined, harness.runner.createContext()),
        /Custom mode requires nonempty user-global guidance/i,
      );
      assert.equal(fixture.received.length, 3, "unreadable Custom guidance must block agent evaluation before HTTP");
      const unreadableManual = await api.evaluateManual(request);
      assert.equal(unreadableManual.connectionId, "owner", "manual evaluation remains available when Custom guidance is unreadable");
      assert.equal(fixture.received.length, 4);
      await rm(guidancePath, { recursive: true, force: true });

      await saveCustomGuidance("Ask only one explicitly scoped question about supplied evidence.");
      const customPrompt = await emitPrompt(harness.runner, cwd);
      const customSection = customPrompt.systemPromptOptions.sections["system-one-agent-usage"];
      assert.match(customSection, /Ask only one explicitly scoped question/);
      assert.match(customSection, /Do not use System One for factual retrieval/);
      await tool.execute("custom-guidance", request, undefined, undefined, harness.runner.createContext());
      assert.equal(fixture.received.length, 5);

      sessionManager.branch(accessEntry.id);
      await harness.runner.emit({ type: "session_tree", newLeafId: accessEntry.id, oldLeafId: null });
      status = await api.getStatus();
      assert.equal(status.agentAccess, true);
      assert.equal(status.sessionConnectionId, null, "branch restoration must follow only the selected branch");
      assert.equal(status.mode, "selective");

      await api.setSessionUse("owner");
      await api.setSessionMode("custom");
      harness.runner.invalidate("test reload");
      harness = await loadHarness(cwd, sessionManager, harness.active);
      await emitSessionStart(harness.runner, "reload");
      const reloadedApi = getSystemOneApi({ events: harness.eventBus });
      status = await reloadedApi.getStatus();
      assert.equal(status.agentAccess, true);
      assert.equal(status.activeConnectionId, "owner");
      assert.equal(status.mode, "custom");
      assert.ok(harness.active.includes("system_one"));
      const reloadedPrompt = await emitPrompt(harness.runner, cwd);
      assert.match(reloadedPrompt.systemPromptOptions.sections["system-one-agent-usage"], /Ask only one explicitly scoped question/);

      await emitSessionStart(harness.runner, "new");
      status = await reloadedApi.getStatus();
      assert.equal(status.agentAccess, false, "new session must return to the user-global off preference");
      assert.equal(status.mode, "selective");
      assert.equal(status.activeConnectionId, "owner");
      assert.equal(status.sessionAgentAccess, null);
      assert.equal(status.sessionConnectionId, null);
      assert.equal(status.sessionMode, null);
      assert.deepEqual(harness.active, ["read", "bash", "other_tool"], "disabling must leave other active tools unchanged");
      await emitSessionStart(harness.runner, "reload");
      status = await reloadedApi.getStatus();
      assert.equal(status.agentAccess, false, "the new-session reset marker must survive reload");

      const directOverride = await reloadedApi.evaluateManual(request, { connectionId: "project", model: "one-call-model" });
      assert.equal(directOverride.connectionId, "project");
      assert.equal(fixture.received.at(-1).url, "/project/v1/systemone");
      assert.equal(fixture.received.at(-1).body.model, "one-call-model");
      assert.equal((await reloadedApi.getStatus()).activeConnectionId, "owner", "manual one-call overrides must not alter the session connection");
    });
  } finally {
    harness?.runner.invalidate("test finished");
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("Pi manual and agent successes redact provider-echoed credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-redaction-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const configHome = join(root, "xdg");
  const fixture = await startServer(true);
  const keyName = "SYSTEM_ONE_PI_RESULT_TEST_KEY";
  const secret = "pi-synthetic-secret-must-not-print";
  const previousKey = process.env[keyName];
  let harness;
  try {
    process.env[keyName] = secret;
    await mkdir(cwd, { recursive: true });
    await withAgentEnvironment({ HOME: root, XDG_CONFIG_HOME: configHome, PI_CODING_AGENT_DIR: agentDir }, async () => {
      await saveSystemOnePreferences(PREFERENCES(true));
      await writeConnectionCatalog({
        version: 1,
        default: "owner",
        connections: { owner: { baseURL: `${fixture.origin}/v1`, model: "model", apiKeyEnv: keyName } },
      }, getDefaultCatalogPath(process.env));
      harness = await loadHarness(cwd, piRuntime.SessionManager.inMemory(cwd));
      await emitSessionStart(harness.runner, "startup");
      const api = getSystemOneApi({ events: harness.eventBus });
      const manual = await api.evaluateManual(request);
      assert.equal(manual.result.providerMetadata["echo[REDACTED]"], "[REDACTED]");
      assert.deepEqual(manual.result.providerMetadata.nested, ["Bearer [REDACTED]"]);

      const toolResult = await toolDefinition(harness.runner).execute("redacted", request, undefined, undefined, harness.runner.createContext());
      assert.equal(toolResult.details.result.providerMetadata["echo[REDACTED]"], "[REDACTED]");
      assert.equal(toolResult.content[0].text.includes(secret), false);
      assert.equal(JSON.stringify(toolResult.details).includes(secret), false);
      assert.deepEqual(fixture.received.map((entry) => entry.authorization), [`Bearer ${secret}`, `Bearer ${secret}`]);
    });
  } finally {
    if (previousKey === undefined) delete process.env[keyName];
    else process.env[keyName] = previousKey;
    harness?.runner.invalidate("test finished");
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

await test("a real Pi agent turn calls the loaded tool and reaches the scripted decision backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-system-one-agent-journey-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const configHome = join(root, "xdg");
  const decisionServer = await startServer(true);
  const piProvider = await startScriptedPiProvider();
  const decisionKey = "pi-scripted-secret-must-not-print";
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      systemOne: { agentAccess: false, defaultConnection: "project" },
    }));
    const userEnv = { HOME: root, XDG_CONFIG_HOME: configHome, PI_CODING_AGENT_DIR: agentDir };
    await saveSystemOnePreferences(PREFERENCES(true, "proactive"), userEnv);
    await writeConnectionCatalog({
      version: 1,
      default: "owner",
      connections: {
        owner: { baseURL: `${decisionServer.origin}/owner/v1`, model: "owner-decision-model", apiKeyEnv: "SYSTEM_ONE_PI_DECISION_KEY" },
        project: { baseURL: `${decisionServer.origin}/project/v1`, model: "project-decision-model" },
      },
    }, getDefaultCatalogPath(userEnv));
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `${piProvider.origin}/v1`,
          api: "openai-completions",
          apiKey: "$SCRIPTED_PI_API_KEY",
          models: [{
            id: "scripted-model",
            name: "Scripted agent test model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          }],
        },
      },
    }));

    const result = await runPi([
      "--print",
      "--no-session",
      "--provider", "scripted",
      "--model", "scripted-model",
      "--extension", extensionPath,
      "--approve",
      "Use System One to judge the supplied release evidence.",
    ], {
      cwd,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        ...userEnv,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        SCRIPTED_PI_API_KEY: "scripted-pi-api-key",
        SYSTEM_ONE_PI_DECISION_KEY: decisionKey,
      },
    });

    assert.equal(result.error, undefined, `${result.error?.message ?? ""}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.status, 0, `Pi agent turn should finish. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /scripted judgment supports waiting/i);
    assert.ok(piProvider.requests.length >= 2, "the Pi agent should complete a tool round-trip");
    const toolRequest = piProvider.requests[0];
    assert.equal(toolRequest.url, "/v1/chat/completions");
    assert.equal(toolRequest.authorization, "Bearer scripted-pi-api-key");
    const offeredTool = toolRequest.body.tools?.find((tool) => tool.function?.name === "system_one");
    assert.ok(offeredTool, "the user-global default-on preference should expose the tool despite project settings");
    assert.deepEqual(Object.keys(offeredTool.function.parameters.properties), ["state", "questions"]);
    assert.match(JSON.stringify(toolRequest.body.messages), /Consider more eligible bounded intermediate judgments/);

    assert.equal(decisionServer.received.length, 1, "the actual Pi agent tool call should finish through the scripted decision server");
    const decision = decisionServer.received[0];
    assert.equal(decision.url, "/owner/v1/systemone", "project-local settings must not redirect the owner catalog default");
    assert.equal(decision.authorization, `Bearer ${decisionKey}`);
    const followupMessages = JSON.stringify(piProvider.requests[1].body.messages);
    assert.equal(followupMessages.includes(decisionKey), false, "the agent's next turn must not receive an echoed credential");
    assert.match(followupMessages, /\[REDACTED\]/, "the agent must receive the sanitized decision result");
    assert.deepEqual(Object.keys(decision.body).sort(), ["model", "questions", "state"]);
    assert.equal(decision.body.model, "owner-decision-model");
    assert.deepEqual(decision.body.state, { evidence: "The project note says release is blocked by a failing check." });
    assert.equal("conversation" in decision.body, false);
    assert.equal("history" in decision.body, false);
    assert.equal("files" in decision.body, false);

    await saveSystemOnePreferences(PREFERENCES(false, "selective"), userEnv);
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      systemOne: { agentAccess: true, defaultConnection: "project" },
    }));
    const offResult = await runPi([
      "--print",
      "--no-session",
      "--provider", "scripted",
      "--model", "scripted-model",
      "--extension", extensionPath,
      "--approve",
      "Summarize the supplied release note.",
    ], {
      cwd,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        ...userEnv,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        SCRIPTED_PI_API_KEY: "scripted-pi-api-key",
      },
    });
    assert.equal(offResult.error, undefined, `${offResult.error?.message ?? ""}\nstdout:\n${offResult.stdout}\nstderr:\n${offResult.stderr}`);
    assert.equal(offResult.status, 0, `default-off Pi turn should finish. stdout:\n${offResult.stdout}\nstderr:\n${offResult.stderr}`);
    assert.match(offResult.stdout, /without invoking System One/i);
    assert.equal(piProvider.requests.at(-1).body.tools?.some((tool) => tool.function?.name === "system_one"), false,
      "a trusted project-local setting cannot enable the agent tool when the user-global default is off");
    assert.equal(decisionServer.received.length, 1, "the disabled real Pi turn must not reach the decision backend");
  } finally {
    await Promise.all([decisionServer.close(), piProvider.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

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
      const status = await getSystemOneApi({ events: harness.eventBus }).getStatus();
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

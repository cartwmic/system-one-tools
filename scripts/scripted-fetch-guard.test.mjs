import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fixtureEnvironment, fixtureUrl } from "./scripted-fetch-guard.mjs";

test("fixture guard fails closed before discovery and clears inherited provider auth", () => {
  const allowed = ["http://127.0.0.1:34567/api/v1/systemone"];
  assert.equal(fixtureUrl(allowed[0], allowed).href, allowed[0]);
  for (const url of ["https://openrouter.ai/api/v1/systemone", "http://127.0.0.1:34567/unexpected", "http://localhost:34567/api/v1/systemone"]) {
    assert.throws(() => fixtureUrl(url, allowed));
  }
  const env = fixtureEnvironment({ PATH: process.env.PATH, OPENROUTER_API_KEY: "unrelated", ANTHROPIC_AUTH_TOKEN: "unrelated", NODE_OPTIONS: "unrelated" }, {
    SYSTEM_ONE_FIXTURE_URLS: JSON.stringify(allowed),
  });
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  const result = spawnSync(process.execPath, ["--import", new URL("./scripted-fetch-guard.mjs", import.meta.url).href, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const guarded = globalThis.fetch;
    let backendCalls = 0;
    globalThis.fetch = (input, options) => { backendCalls++; assert.equal(String(input), 'http://127.0.0.1:34567/api/v1/systemone'); assert.equal(options.redirect, 'error'); return Promise.resolve(new Response('DUMMY')); };
    assert.equal(globalThis.fetch, guarded, 'CLI undici installation must not replace preload');
    assert.throws(() => fetch('https://openrouter.ai/api/v1/systemone'), /non-loopback/);
    assert.throws(() => fetch('http://127.0.0.1:34567/unexpected'), /unexpected fixture/);
    assert.equal(backendCalls, 0, 'refused URLs never reach assigned backend');
    globalThis.fetch = guarded; // must not create recursive delegation
    assert.equal(await (await fetch('http://127.0.0.1:34567/api/v1/systemone')).text(), 'DUMMY');
    assert.equal(backendCalls, 1);
    console.log('PRE_DISCOVERY_DENIED');
  `], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PRE_DISCOVERY_DENIED/);
});

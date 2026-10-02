// Preload with node --import before Pi discovery, not from a late extension hook.
import assert from "node:assert/strict";
export function fixtureUrl(input, allowed) {
  const url = new URL(typeof input === "string" ? input : (input.url ?? input.href));
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname), "Scripted proof refuses non-loopback transport");
  assert.ok(allowed.includes(url.href), "Scripted proof refuses unexpected fixture URL");
  return url;
}
export function fixtureEnvironment(env, values) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|CREDENTIAL|^AWS_|^AZURE_|^GOOGLE_|^OP_|^ANTHROPIC_|^OPENAI_|^OPENROUTER_)/i.test(key)) delete clean[key];
  }
  delete clean.NODE_OPTIONS;
  return { ...clean, ...values };
}
if (process.env.SYSTEM_ONE_FIXTURE_URLS) {
  const allowed = JSON.parse(process.env.SYSTEM_ONE_FIXTURE_URLS);
  assert.ok(Array.isArray(allowed) && allowed.length > 0);
  for (const url of allowed) fixtureUrl(url, allowed);
  // TEST ONLY: logical builtin vendor URLs can map to exact local fixtures.
  const mapping = JSON.parse(process.env.SYSTEM_ONE_FIXTURE_MAPPING ?? "{}");
  for (const [logical, local] of Object.entries(mapping)) {
    assert.equal(new URL(logical).protocol, "https:");
    fixtureUrl(local, allowed);
  }
  let original = globalThis.fetch;
  const guardedFetch = (input, options) => {
    const logical = String(typeof input === "string" ? input : (input.url ?? input.href));
    const target = mapping[logical] ?? logical;
    fixtureUrl(target, allowed);
    const request = input instanceof Request && target !== logical ? new Request(target, input) : target === logical ? input : target;
    return original(request, { ...options, redirect: "error" });
  };
  // Pi's CLI installs undici globals during setup. Keep this TEST-ONLY guard
  // across that supported initialization, before any discovery can run.
  Object.defineProperty(globalThis, "fetch", {
    configurable: false,
    get: () => guardedFetch,
    // setupCli installs matching undici fetch/Headers/Response constructors.
    // Keep the guard, but delegate to that backend so native HTTP errors retain
    // the SDK's Headers identity and therefore its real retry behavior.
    set: value => { if (typeof value === "function" && value !== guardedFetch) original = value; },
  });
}

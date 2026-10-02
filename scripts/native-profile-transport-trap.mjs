// Minimal local-only transport admission. Called by profile executor before Pi.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureEnvironment } from './scripted-fetch-guard.mjs';
export async function transportTrap(piRoot) {
  const home=await mkdtemp(join(tmpdir(),'native-transport-trap-'));let hits=0;
  const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;assert.equal(req.url,'/systemone');assert.equal(req.headers.authorization,'Bearer fixture-only');assert.equal(JSON.parse(raw).state.probe,true);hits++;res.setHeader('content-type','application/json');res.end(JSON.stringify({answers:{ready:{type:'noul',noul:0.9}}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const url=p=>pathToFileURL(join(piRoot,p)).href;
  const guard=new URL('./scripted-fetch-guard.mjs',import.meta.url).href;
  try {
    const code=`import assert from 'node:assert/strict';
      const {setupCli}=await import(${JSON.stringify(url('dist/cli/setup.js'))});setupCli();
      const {ModelRuntime}=await import(${JSON.stringify(url('dist/core/model-runtime.js'))});
      const {ModelRegistry}=await import(${JSON.stringify(url('dist/core/model-registry.js'))});
      const runtime=await ModelRuntime.create({authPath:${JSON.stringify(join(home,'auth.json'))},modelsPath:null,modelsStorePath:${JSON.stringify(join(home,'cache.json'))},refreshOnCreate:false});
      await runtime.setRuntimeApiKey('openrouter','fixture-only',{allowNetwork:false});
      const registry=new ModelRegistry(runtime);registry.registerProvider('openrouter',{baseUrl:${JSON.stringify(origin)}});
      const m=registry.getModelOfType('classifier','openrouter','~typesafe/jev-latest');assert.ok(m);
      const result=await registry.classify(m,{state:{probe:true},questions:{ready:{type:'bool',instructions:'Ready?',criteria:{true:'Yes',false:'No'}}}},{maxRetries:0});assert.equal(result.stopReason,'stop',JSON.stringify(result));assert.equal(result.answers.ready.probability,0.9);
      // Only local negative target: never a vendor probe.
      assert.throws(()=>fetch(${JSON.stringify(origin+'/unlisted')}),/unexpected fixture/);console.log('NATIVE_TRANSPORT_TRAP_PASS');`;
    const env=fixtureEnvironment(process.env,{HOME:home,PI_CODING_AGENT_DIR:join(home,'agent'),PI_OFFLINE:'1',SYSTEM_ONE_FIXTURE_URLS:JSON.stringify([origin+'/systemone'])});
    const child=spawn(process.execPath,['--import',guard,'--input-type=module','-e',code],{env});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
    const status=await new Promise((r,j)=>{child.on('error',j);child.on('close',r)}).finally(()=>clearTimeout(timer));assert.equal(status,0,stderr);assert.equal(hits,1);assert.match(stdout,/NATIVE_TRANSPORT_TRAP_PASS/);return {status:'PASS',hits,stdout};
  } finally {await new Promise(r=>{server.close(r);server.closeAllConnections()});await rm(home,{recursive:true,force:true});}
}

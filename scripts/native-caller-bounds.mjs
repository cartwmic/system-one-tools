// TEST ONLY: real disposable Pi RPC callers, native registry and llama.cpp adapter.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
import { installedPi } from './live-jev-caller.mjs';
import { fixtureEnvironment } from './scripted-fetch-guard.mjs';
import { transportTrap } from './native-profile-transport-trap.mjs';
const request = {state:{color:'blue'},questions:{color:{type:'choice',instructions:'Which supplied color is present?',criteria:{blue:'Blue',red:'Red'}}}};
const artifactRoot = process.env.SYSTEM_ONE_BOUNDS_ARTIFACT_ROOT;
const delay = ms => new Promise(r=>setTimeout(r,ms));
export async function nativeCallerBounds() {
  const pi = await installedPi();
  const admission = await transportTrap(pi.piRoot);
  const outcomes=[];
  for (const [caller, mode] of [['agent','success'],['agent','transient'],['agent','terminal'],['agent','auth'],['agent','malformed'],['agent','deadline'],['agent','cancel-body'],['agent','cancel-wait'],['manual','terminal'],['manual','deadline'],['manual','cancel-body'],['manual','cancel-wait']]) {
    const outcome=await runCase(pi,caller,mode);
    outcomes.push(outcome);
    console.log(JSON.stringify({nativeBounds:{caller,mode,elapsedMs:outcome.elapsedMs,requests:outcome.operations.length,attempts:outcome.groups.map(g=>g.attempts),completed:outcome.completed}}));
  }
  return {admission,outcomes};
}
async function runCase(pi,caller,mode) {
  const home=await mkdtemp(join(tmpdir(),'native-bounds-'));
  const agent=join(home,'agent'), report=join(home,'manual.json'), observation=join(home,'classify.json');
  const operations=[], events=[], timers=new Set();
  let fault, child, stderr='', chatCalls=0, completed=false, cancelled=false, nativeStarted, terminalAt;
  const later=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);};
  const server=createServer(async(req,res)=>{try {
    let raw='';for await(const c of req)raw+=c;
    const body=JSON.parse(raw);assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer fixture-only');
    if(req.url==='/v1/chat/completions') {
      assert.equal(caller,'agent');chatCalls++;assert.ok(chatCalls<=2);
      let delta,finish='stop';
      if(chatCalls===1) {assert.ok(body.tools.some(t=>t.function.name==='system_one'));delta={role:'assistant',tool_calls:[{id:'bounds',type:'function',function:{name:'system_one',arguments:JSON.stringify(request)}}]};finish='tool_calls';}
      else {assert.equal(body.messages.at(-1).role,'tool');delta={role:'assistant',content:'BOUNDS_AGENT_COMPLETED'};}
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const c of [{delta,finish_reason:null},{delta:{},finish_reason:finish}])res.write(`data: ${JSON.stringify({id:'bounds',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,...c}]})}\n\n`);
      res.end('data: [DONE]\n\n');return;
    }
    assert.ok(['/tokenize','/apply-template','/completion'].includes(req.url));assert.equal(body.model,'cold-classifier');
    nativeStarted ??= Date.now();
    const bodyKey=JSON.stringify([req.url,body]);
    const previous=operations.findLast(o=>o.bodyKey===bodyKey);
    const retry=previous?.bodyKey===bodyKey && previous.status===503;
    const group=retry?previous.group:operations.length;
    const attempt=retry?previous.attempt+1:1;
    const key=JSON.stringify([req.url,body,group]);
    const op={path:req.url,key,bodyKey,group,attempt,atMs:Date.now()-nativeStarted};operations.push(op);
    res.on('close',()=>{op.closedMs=Date.now()-nativeStarted;op.bodyComplete=res.writableEnded;});
    const respond=value=>{if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));}};
    if(req.url==='/tokenize') {
      assert.deepEqual(Object.keys(body).sort(),['add_special','content','model','parse_special']);
      const tokens=body.content==='\n'?[1]:body.content==='\nA'?[1,10]:body.content==='\nB'?[1,11]:null;
      assert.ok(tokens,'cold diagnostic token fixture only');assert.equal(body.add_special,false);assert.equal(body.parse_special,false);
      if(body.content==='\nA' && ['transient','terminal','auth','cancel-wait'].includes(mode)) {
        if(mode!=='transient'||attempt<=2) {
          op.status=mode==='auth'?401:503;
          res.writeHead(op.status,{'content-type':'application/json','retry-after':mode==='cancel-wait'?'3':'0.05'});res.end('{"error":"fixture refusal"}');
          if(mode==='cancel-wait'&&caller==='agent')later(()=>{cancelled=true;child.stdin.write('{"type":"abort"}\n');},500);
          return;
        }
      }
      if(mode==='malformed'&&body.content==='\nA') {op.status=200;respond({tokens:'invalid'});return;}
      op.status=200;
      if(mode==='deadline'&&body.content==='\nA')later(()=>respond({tokens}),18000);
      else respond({tokens});return;
    }
    if(req.url==='/apply-template') {
      assert.ok(Array.isArray(body.messages));assert.match(JSON.stringify(body.messages),/Which supplied color is present/);assert.match(JSON.stringify(body.messages),/blue/);
      op.status=200;respond({prompt:'Scripted toy prompt\n'});return;
    }
    assert.equal(body.prompt,'Scripted toy prompt\n');assert.equal(body.n_predict,1);assert.ok(body.n_probs>=256);
    op.status=200;
    if(['deadline','cancel-body'].includes(mode)) {
      res.writeHead(200,{'content-type':'application/json'});res.write('{"completion_probabilities":');
      if(mode==='cancel-body'&&caller==='agent')later(()=>{cancelled=true;child.stdin.write('{"type":"abort"}\n');},500);
      return;
    }
    respond({completion_probabilities:[{top_logprobs:[{id:10,logprob:-0.1},{id:11,logprob:-2}]}]});
  }catch(e){fault=e;res.writeHead(500);res.end('fixture validation failed');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const output={caller,mode};
  try {
    await mkdir(join(agent,'system-one'),{recursive:true});
    await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[],quietStartup:true}));
    await writeFile(join(agent,'system-one/preferences.json'),JSON.stringify({version:1,agentAccess:true,defaultMode:'explicit',defaultClassifier:{provider:'local-bounds',id:'cold-classifier'}}));
    await writeFile(join(agent,'models.json'),JSON.stringify({providers:{scripted:{baseUrl:origin+'/v1',api:'openai-completions',apiKey:'fixture-only',models:[{id:'chat',name:'Chat',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:512}]},'local-bounds':{baseUrl:origin+'/v1',api:'llama-cpp-classify',apiKey:'fixture-only',models:[{type:'classifier',id:'cold-classifier',name:'Cold',input:['text'],contextWindow:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
    const manual=join(home,'manual.mjs');
    await writeFile(manual,`import {writeFile} from 'node:fs/promises';import {getSystemOneApi} from ${JSON.stringify(pathToFileURL(resolve(sourceRoot, 'packages/pi-system-one/src/internal.js')).href)};
import {classify} from ${JSON.stringify(pathToFileURL(join(pi.piRoot,'node_modules/@earendil-works/pi-ai/dist/api/llama-cpp-classify.js')).href)};
export default pi=>{pi.on('session_start',(_,ctx)=>{const original=ctx.modelRegistry.classify.bind(ctx.modelRegistry);let count=0;ctx.modelRegistry.classify=async(...args)=>{count++;const result=await original(...args);await writeFile(${JSON.stringify(observation)},JSON.stringify({count,maxRetries:args[2].maxRetries,stopReason:result.stopReason,aborted:args[2].signal.aborted}));return result;};});pi.registerProvider('local-bounds',{baseUrl:${JSON.stringify(origin+'/v1')},apiKey:'fixture-only',api:'llama-cpp-classify',classifiers:{'llama-cpp-classify':{classify}},models:[{type:'classifier',api:'llama-cpp-classify',id:'cold-classifier',name:'Cold',input:['text'],contextWindow:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});pi.registerCommand('bounds-manual',{handler:async(_,ctx)=>{const controller=new AbortController();let timer;${mode.startsWith('cancel-')?'timer=setTimeout(()=>controller.abort(),1500);':''}try {const result=await getSystemOneApi(pi).evaluateManual(${JSON.stringify(request)},{signal:controller.signal},ctx);await writeFile(${JSON.stringify(report)},JSON.stringify({completed:true,result}));}catch(e){await writeFile(${JSON.stringify(report)},JSON.stringify({completed:true,error:e.name}));}finally{clearTimeout(timer);}}});};`);
    const env=fixtureEnvironment(process.env,{HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),XDG_STATE_HOME:join(home,'state'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',SYSTEM_ONE_FIXTURE_URLS:JSON.stringify(['/tokenize','/apply-template','/completion','/v1/chat/completions'].map(p=>origin+p))});
    child=spawn(process.execPath,['--import',pathToFileURL(resolve(sourceRoot, 'scripts/scripted-fetch-guard.mjs')).href,pi.piEntry,'--mode','rpc','--no-session','--no-extensions','--no-context-files','--provider','scripted','--model','chat','--extension',resolve(sourceRoot, 'packages/pi-system-one/src/index.js'),'--extension',manual,'--approve'],{cwd:home,env,stdio:['pipe','pipe','pipe']});
    let buffer='';child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',c=>{buffer+=c;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const e=JSON.parse(line);events.push(e);if(e.type==='agent_end'){completed=true;terminalAt=Date.now();}}catch{}}});
    child.stdin.write(JSON.stringify({type:'prompt',message:caller==='agent'?'Use System One on the supplied toy color.':'/bounds-manual'})+'\n');
    // 70s watchdog is only failure detection; a killed process is never completion.
    const watchdog=Date.now()+70000;
    let manualOutcome;
    while(Date.now()<watchdog) {
      if(fault)throw fault;
      if(caller==='manual'){try{manualOutcome=JSON.parse(await readFile(report,'utf8'));completed=manualOutcome.completed;terminalAt=Date.now();}catch{}}
      if(completed)break;
      if(child.exitCode!==null)throw new Error(`Pi exited before completion: ${stderr}`);
      await delay(25);
    }
    assert.equal(completed,true,`public caller watchdog failure: ${stderr}`);
    output.elapsedMs=terminalAt-nativeStarted;
    output.classify=JSON.parse(await readFile(observation,'utf8'));
    assert.equal(output.classify.count,1,'exactly one delegated native evaluation');
    assert.equal(output.classify.maxRetries,2);
    assert.equal(output.classify.stopReason,['success','transient'].includes(mode)?'stop':mode.startsWith('cancel-')||mode==='deadline'?'aborted':'error');
    const count=operations.length;await delay(mode==='cancel-wait'?3500:300);
    assert.equal(operations.length,count,'no post-terminal requests');
    if(caller==='manual')assert.ok(events.some(e=>e.type==='response'&&e.command==='prompt'&&e.success&&e.data?.disposition==='handled'),'actual owner API command returned to Pi');
    if(['terminal','auth','malformed','cancel-wait'].includes(mode))assert.ok(!operations.some(o=>o.path==='/completion'),'failed preparation never proceeds to readout');
    output.operations=operations.map(({key,...o})=>o);
    output.groups=Object.values(Object.groupBy(operations,o=>o.key)).map(os=>({path:os[0].path,body:JSON.parse(os[0].key)[1],attempts:os.length}));
    const usable=['success','transient'].includes(mode);
    if(caller==='agent') {
      const tool=events.find(e=>e.type==='tool_execution_end');assert.ok(tool,'actual outer tool must finish');output.toolResult=tool.result;
      assert.equal(Boolean(tool.result?.details?.result?.answers),usable);
      if(usable)assert.equal(tool.result.details.result.answers.color.choice,'blue');
      if(!mode.startsWith('cancel-')){assert.equal(chatCalls,2);assert.match(JSON.stringify(events),/BOUNDS_AGENT_COMPLETED/);}
      else {assert.equal(cancelled,true);assert.equal(tool.result.details.result.stopReason,'aborted');}
    }else {output.manualOutcome=manualOutcome;assert.equal(Boolean(manualOutcome.result?.result?.answers),false);assert.equal(chatCalls,0);assert.equal(manualOutcome.result.result.stopReason,mode==='terminal'?'error':'aborted');}
    if(usable)assert.ok(new Set(output.groups.map(g=>JSON.stringify([g.path,g.body]))).size>3,'cold successful distinct HTTP operation bodies');
    const expected=mode==='transient'?3:mode==='terminal'?3:1;
    assert.equal(output.groups.find(g=>g.body.content==='\nA').attempts,expected);
    assert.ok(output.groups.every(g=>g.attempts<=3));
    if(mode==='deadline') {
      assert.ok(output.groups.length>3,'later native stage reached');
      assert.ok(operations.at(-1).atMs>=17500,'stage one consumed budget');
      // 2s scheduling/stream finalization tolerance, not a reset or watchdog success.
      assert.ok(output.elapsedMs>=29500&&output.elapsedMs<=32000,`shared 30s deadline: ${output.elapsedMs}`);
    }
    if(mode==='cancel-wait')assert.ok(output.elapsedMs<3000,'cancel completes before nonzero 3s retry wait');
    if(mode==='cancel-body')assert.ok(operations.at(-1).bodyComplete===false,'active response body aborted');
    output.completed=true;output.noLaterRequests=true;
    return output;
  }catch(e){output.failure=String(e);output.operations=operations;output.stderr=stderr;throw e;}
  finally {
    if(artifactRoot){await mkdir(artifactRoot,{recursive:true});await writeFile(join(artifactRoot,`${caller}-${mode}-${Date.now()}.json`),JSON.stringify({...output,events},null,2));}
    for(const t of timers)clearTimeout(t);
    if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('close',r));}
    await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(home,{recursive:true,force:true});
  }
}

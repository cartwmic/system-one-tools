// TEST ONLY actual Pi caller orchestration; never imported by product or npm checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureEnvironment } from './scripted-fetch-guard.mjs';
import { UPSTREAM } from './live-jev-proof.mjs';
export const SLOTS=['tool-choice','tool-bool','tool-score','manual-choice','manual-bool','manual-score'];
export function toyRequest(slot) {const type=slot.split('-')[1];return {state:{text:'red blue red'},questions:{color:{type,instructions:'Judge the red color in this toy text.',criteria:type==='choice'?{red:'Red dominates',blue:'Blue dominates'}:type==='bool'?{true:'Red dominates',false:'Red does not dominate'}:['No red','Some red','Mostly red']}}};}
export function safeResult(result) {const out={stopReason:['stop','error','aborted'].includes(result?.stopReason)?result.stopReason:'exception'};if(out.stopReason==='stop'){const clean=v=>{if(typeof v==='number')return Number.isFinite(v)?v:undefined;if(typeof v==='boolean')return v;if(typeof v==='string')return ['red','blue','choice','bool','score'].includes(v)?v:undefined;if(Array.isArray(v))return v.map(clean);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>['color','type','choice','probability','probabilities','confidence','score','value','red','blue','true','false'].includes(k)).map(([k,x])=>[k,clean(x)]).filter(([,x])=>x!==undefined));};out.answers=clean(result.answers);}const u=result?.usage;if(u)out.usage=Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].filter(k=>Number.isFinite(u[k])&&u[k]>=0).map(k=>[k,u[k]]));return out;}
export async function observeClassify(original,args,record) {try {const result=await original(...args);await record(safeResult(result));return result;}catch(e){await record({stopReason:'exception'});throw e;}}
const python=String.raw`import os,pty,select,signal,sys,time
def terminated(*args):raise RuntimeError('Owned watchdog expired')
signal.signal(signal.SIGTERM,terminated)
pid,fd=pty.fork()
if pid==0: os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
output=bytearray();cursor=0
def wait(token,timeout=40):
 global cursor
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  tokens=token if isinstance(token,list) else [token]
  for needle in tokens:
   pos=output.find(needle.encode(),cursor)
   if pos>=0:cursor=pos+len(needle);return
  ready,_,_=select.select([fd],[],[],0.1)
  if ready:
   try:data=os.read(fd,8192)
   except OSError:break
   if not data:break
   output.extend(data)
 if os.environ.get('JEV_DUMMY_DEBUG')=='1':sys.stderr.write(output.decode(errors='replace'))
 raise RuntimeError('Missing completed caller signal '+str(token))
def send(text):os.write(fd,text.encode()+b'\r')
try:
 wait('JEV_READY')
 if os.environ['JEV_SLOT'].startswith('tool-'):
  send('Use System One on the toy colors.');wait('JEV_AGENT_FINISHED')
 else:
  send('/so ask');wait('System One request JSON');os.write(fd,b'\x07');wait('red blue');os.write(fd,b'\r')
  wait('Classifier for this call only');os.write(fd,b'\r');wait(['System One result','System One failed/aborted'])
  os.write(fd,b'\r');send('/jev-completed');wait('JEV_MANUAL_FINISHED')
finally:
 try:os.killpg(pid,signal.SIGKILL)
 except ProcessLookupError:pass
 try:os.waitpid(pid,0)
 except ChildProcessError:pass
 os.close(fd)
`;
// A fresh process per logical slot; no outer retry. Classify observer only records
// an unchanged native return/throw. PTY must independently complete its caller.
export async function runSlot({slot,budget,piEntry,piRoot,key,forward=globalThis.fetch,dummyDebug=false}) {
  if(dummyDebug)assert.equal(key,'fixture-only');
  const home=await mkdtemp(join(tmpdir(),'jev-slot-'));const agent=join(home,'.pi/agent'),report=join(home,'result.json');let fault=false,chatCalls=0,observeCount=0;
  await mkdir(join(agent,'system-one'),{recursive:true});
  const request=toyRequest(slot);
  const server=createServer(async(req,res)=>{try {
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(req.url==='/systemone') {
      assert.equal(req.method,'POST');assert.equal(req.headers.authorization,`Bearer ${key}`);assert.equal(body.model,'~typesafe/jev-latest');assert.deepEqual(body.state,request.state);
      const expected={...request.questions.color,type:request.questions.color.type==='bool'?'noul':request.questions.color.type};assert.deepEqual(body.questions,{color:expected});assert.deepEqual(Object.keys(body).sort(),['model','questions','state']);
      budget.transport(UPSTREAM);
      const abort=new AbortController();req.on('aborted',()=>abort.abort());res.on('close',()=>{if(!res.writableEnded)abort.abort();});
      const upstream=await forward(UPSTREAM,{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:raw,signal:abort.signal,redirect:'error'});
      const headers=Object.fromEntries([...upstream.headers].filter(([k])=>!['content-length','content-encoding','transfer-encoding','connection','keep-alive','upgrade','proxy-authenticate','proxy-authorization','trailer'].includes(k.toLowerCase())));
      res.writeHead(upstream.status,headers);
      // Streaming is transparent: delayed bodies remain inside the product deadline.
      for await(const chunk of upstream.body??[])res.write(chunk);res.end();return;
    }
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer fixture-only');assert.ok(slot.startsWith('tool-'));chatCalls++;assert.ok(chatCalls<=2);
    let delta,finish='stop';
    if(chatCalls===1){assert.ok(body.tools.some(t=>t.function.name==='system_one'));delta={role:'assistant',tool_calls:[{id:'jev-tool',type:'function',function:{name:'system_one',arguments:JSON.stringify(request)}}]};finish='tool_calls';}
    else {assert.equal(body.messages.at(-1).role,'tool');delta={role:'assistant',content:'JEV_AGENT_FINISHED'};}
    res.writeHead(200,{'content-type':'text/event-stream'});const base={id:'toy',object:'chat.completion.chunk',created:1,model:body.model};for(const c of [{delta,finish_reason:null},{delta:{},finish_reason:finish}])res.write(`data: ${JSON.stringify({...base,choices:[{index:0,...c}]})}\n\n`);res.end('data: [DONE]\n\n');
  }catch{fault=true;res.writeHead(500);res.end('Toy proof transport refused');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const editor=join(home,'editor.sh');await writeFile(editor,`#!/bin/sh\nprintf '%s' '${JSON.stringify(request)}' > "$1"\n`);await chmod(editor,0o700);
    await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[],quietStartup:true,externalEditor:editor,defaultProvider:'scripted',defaultModel:'toy-chat'}));
    await writeFile(join(agent,'system-one/preferences.json'),JSON.stringify({version:1,agentAccess:slot.startsWith('tool-'),defaultMode:'explicit',defaultClassifier:{provider:'openrouter',id:'~typesafe/jev-latest'}}));
    await writeFile(join(agent,'models.json'),JSON.stringify({providers:{scripted:{baseUrl:origin+'/v1',api:'openai-completions',apiKey:'$SCRIPTED_PI_API_KEY',models:[{id:'toy-chat',name:'Toy chat',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:512}]}}}));
    const observer=join(home,'observer.mjs');await writeFile(observer,`import {writeFile} from 'node:fs/promises';import {observeClassify} from ${JSON.stringify(import.meta.url)};
export default pi=>{pi.on('session_start',async(_,ctx)=>{const registry=ctx.modelRegistry,original=registry.classify.bind(registry);let count=0;registry.classify=(...args)=>{if(++count!==1)throw new Error('extra logical evaluation refused');return observeClassify(original,args,async result=>{await writeFile(${JSON.stringify(report)},JSON.stringify(result));});};ctx.ui.notify('JEV_READY','info');});pi.registerCommand('jev-completed',{handler:async(_,ctx)=>ctx.ui.notify('JEV_MANUAL_FINISHED','info')});};`);
    const env=fixtureEnvironment(process.env,{HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),XDG_STATE_HOME:join(home,'state'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',TERM:'xterm-256color',OPENROUTER_API_KEY:key,SCRIPTED_PI_API_KEY:'fixture-only',JEV_SLOT:slot,JEV_DUMMY_DEBUG:dummyDebug?'1':'0',SYSTEM_ONE_FIXTURE_URLS:JSON.stringify([origin+'/systemone',origin+'/v1/chat/completions']),SYSTEM_ONE_FIXTURE_MAPPING:JSON.stringify({[UPSTREAM]:origin+'/systemone'})});
    env.NODE_OPTIONS=`--import=${pathToFileURL(resolve('scripts/scripted-fetch-guard.mjs')).href}`;
    const child=spawn('python3',['-c',python,process.execPath,piEntry,'--no-extensions','--no-context-files','--provider','scripted','--model','toy-chat','--extension',resolve('packages/pi-system-one/src/index.js'),'--extension',observer],{cwd:home,env,stdio:['ignore','ignore',dummyDebug?'inherit':'ignore']});
    let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},90000);
    const status=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);}).finally(()=>clearTimeout(timer));
    let result;try{result=JSON.parse(await readFile(report,'utf8'));observeCount=1;}catch{result={stopReason:'missing-outcome'};}
    assert.equal(status,0,'PTY caller did not complete');assert.equal(timedOut,false);assert.equal(fault,false,'forwarder refused');assert.equal(observeCount,1);if(slot.startsWith('tool-'))assert.equal(chatCalls,2);
    return result;
  } finally {await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(home,{recursive:true,force:true});}
}
export async function installedPi() {const entry=await realpath(execFileSync('which',['pi'],{encoding:'utf8'}).trim());return {piEntry:entry,piRoot:resolve(dirname(entry),'../..')};}

#!/usr/bin/env node
// Source-profile proof. No package install, owner config, hooks, or live transport.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, cp, chmod, realpath, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureEnvironment } from './scripted-fetch-guard.mjs';
import { transportTrap } from './native-profile-transport-trap.mjs';
const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: node scripts/test-native-profiles.mjs --dotfiles-source SOURCE --profile personal|axon-work-computer');
assert.equal(args[0], '--dotfiles-source'); assert.equal(args[2], '--profile');
const source = await realpath(args[1]), profile = args[3];
assert.ok(['personal', 'axon-work-computer'].includes(profile));
const personal = profile === 'personal';
const artifactRoot = '/Volumes/Workshop/macbook/loop-engine/runs/run-1790885328723869000-1-1157';
const capture = await mkdtemp(join(artifactRoot, `T5-native-${profile}-attempt-`));
const root = join(capture, 'disposable'), home = join(root, 'home'), agent = join(home, '.pi/agent'), project = join(root, 'project');
for (const p of [agent, project, join(root,'config'), join(root,'cache'), join(root,'state')]) await mkdir(p, {recursive:true});
const piEntry = await realpath(execFileSync('which', ['pi'], {encoding:'utf8'}).trim());
const piRoot = resolve(dirname(piEntry), '../..');
const moduleUrl = p => pathToFileURL(join(piRoot,p)).href;
const requests = []; let fixtureError;
let server;
const request = {state:{evidence:'PROFILE_AGENT_EVIDENCE'},questions:{release:{type:'choice',instructions:'Which option?',criteria:{wait:'Wait',proceed:'Proceed'}},ready:{type:'bool',instructions:'Ready?',criteria:{true:'Ready',false:'Not ready'}},quality:{type:'score',instructions:'Quality?',criteria:['Poor','Good']}}};
async function run(command, argv, env, label, timeout=60000) {
  const child = spawn(command, argv, {cwd:project,env,stdio:['ignore','pipe','pipe']});
  let stdout='', stderr='';
  child.stdout.on('data', c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  const result=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',(status,signal)=>res({status,signal}));}).finally(()=>clearTimeout(timer));
  await writeFile(join(capture,`${label}.stdout`),stdout); await writeFile(join(capture,`${label}.stderr`),stderr);
  assert.equal(result.status,0,`${label} failed ${result.signal}\n${stderr}\n${stdout.slice(-8000)}`);
  return stdout;
}
let env = fixtureEnvironment(process.env,{HOME:home,XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache'),XDG_STATE_HOME:join(root,'state'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',TERM:'xterm-256color'});
try {
  await writeFile(join(capture,'transport-trap.json'),JSON.stringify(await transportTrap(piRoot),null,2));
  const config=join(root,'config/chezmoi.json'); await writeFile(config,JSON.stringify({data:{profile}}));
  const base=['--source',source,'--destination',home,'--config',config,'--cache',join(root,'cache'),'--persistent-state',join(root,'state/chezmoi.json'),'--no-tty','--color=false','--refresh-externals=never'];
  const render=async target=>{
    const name=target.split('/').at(-1);
    const expected=target.endsWith('settings.json')?'dot_pi/private_agent/private_settings.json.tmpl':target.endsWith('models.json')?'dot_pi/private_agent/private_models.json.tmpl':`dot_pi/private_agent/extensions/system-one/${name}`;
    assert.equal((await run('chezmoi',[...base,'source-path',join(home,target)],env,`mapping-${name}`)).trim(),join(source,expected));
    return run('chezmoi',[...base,'cat',join(home,target)],env,`render-${name}`);
  };
  const managed=(await run('chezmoi',[...base,'managed','--include=files','--path-style=absolute'],env,'managed')).split('\n');
  const settings=JSON.parse(await render('.pi/agent/settings.json'));
  const models=JSON.parse(await render('.pi/agent/models.json'));
  assert.equal(settings.packages.filter(p=>p==='https://github.com/cartwmic/system-one-tools').length,1);
  assert.deepEqual(settings.codemode,{mode:'only'}); assert.deepEqual(settings.defaultTools,['+codemode']);
  assert.equal(settings.defaultProvider,personal?'openai-codex':'private-glm'); assert.equal(settings.defaultModel,personal?'gpt-6.1-sol':'glm-5.3-flash');
  assert.equal(settings.packages.includes('https://github.com/olixis/pi-openrouter-plus'),personal);
  assert.equal(managed.includes(join(agent,'extensions/openrouter-gate/index.ts')),personal);
  assert.deepEqual((await readdir(join(source,'dot_pi/private_agent/extensions/system-one'))).sort(),['AGENTS.md','README.md']);
  assert.ok(!(await readFile(join(source,'.chezmoiremove'),'utf8')).includes('.pi/agent/extensions/system-one'));
  for(const name of ['README.md','AGENTS.md']) {const text=await render(`.pi/agent/extensions/system-one/${name}`); assert.equal(text,await readFile(join(source,'dot_pi/private_agent/extensions/system-one',name),'utf8'));}
  // Snapshot complete source configuration; only relevant packages are composed.
  await writeFile(join(capture,'source-composition.json'),JSON.stringify({profile,settings,models,retained:'local source packages/pi-system-one/src/index.js',included:personal?['source openrouter-gate','installed read-only pi-openrouter-plus routing']:[],excludedPackages:settings.packages.filter(p=>!['https://github.com/cartwmic/system-one-tools','https://github.com/olixis/pi-openrouter-plus'].includes(p)),excluded:'Unrelated extensions, MCP servers, services, secret-backed providers. Rendered model metadata retained; executable credential expressions removed from disposable runtime. Chat provider overridden explicitly to scripted fixture; source defaults are asserted, not called.'},null,2));
  // Guard is installed before importing SDK/model discovery, even in this parent.
  server=createServer(async(req,res)=>{try {
    let raw=''; for await(const chunk of req) raw+=chunk; const body=raw?JSON.parse(raw):null;
    requests.push({path:req.url,headers:req.headers,body});
    if(req.url==='/api/v1/models') {res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'z-ai/glm-5.3-flash',name:'Fixture chat',context_length:8192,architecture:{input_modalities:['text']},pricing:{prompt:'0',completion:'0'},top_provider:{max_completion_tokens:512}}]}));return;}
    assert.equal(req.method,'POST'); assert.equal(req.headers.authorization,'Bearer fixture-only');
    if(req.url==='/api/v1/systemone') {
      assert.equal(body.model,'~typesafe/jev-latest');assert.deepEqual(Object.keys(body).sort(),['model','questions','state']); assert.deepEqual(Object.keys(body.state),['evidence']);
      assert.ok(['PROFILE_AGENT_EVIDENCE','PROFILE_MANUAL_PRIVATE','PROFILE_CODEMODE_EVIDENCE'].includes(body.state.evidence));
      assert.deepEqual(Object.keys(body.questions).sort(),['quality','ready','release']);
      assert.equal(body.questions.ready.type,'noul');assert.equal(body.questions.quality.type,'score');assert.equal(body.questions.release.type,'choice');assert.deepEqual(body.questions.ready.criteria,{true:'Ready',false:'Not ready'});assert.deepEqual(body.questions.quality.criteria,['Poor','Good']);assert.deepEqual(body.questions.release.criteria,body.state.evidence==='PROFILE_MANUAL_PRIVATE'?{PRIVATE_NATIVE_MANUAL_OUTPUT:'Wait',proceed:'Proceed'}:{wait:'Wait',proceed:'Proceed'});
      res.setHeader('content-type','application/json');res.end(JSON.stringify({answers:{release:{type:'choice',choice:body.state.evidence==='PROFILE_MANUAL_PRIVATE'?'PRIVATE_NATIVE_MANUAL_OUTPUT':'wait',probabilities:{[body.state.evidence==='PROFILE_MANUAL_PRIVATE'?'PRIVATE_NATIVE_MANUAL_OUTPUT':'wait']:0.8,proceed:0.2},confidence:0.9},ready:{type:'noul',noul:0.9},quality:{type:'score',score:1,confidence:0.9}},usage:{input_tokens:5,output_tokens:3}}));return;
    }
    assert.ok(['/api/v1/chat/completions','/v1/chat/completions'].includes(req.url));
    if(personal && req.url==='/api/v1/chat/completions'){assert.equal(req.headers['http-referer'],'https://github.com/olixis/pi-openrouter-plus');assert.equal(req.headers['x-title'],'pi-openrouter-realtime');}
    const user=[...body.messages].reverse().find(m=>m.role==='user');const text=JSON.stringify(user);
    const toolResult=body.messages.at(-1)?.role==='tool';
    let delta, finish='stop';
    if(!toolResult && text.includes('RUN_AGENT')) {assert.ok(body.tools.some(t=>t.function.name==='codemode'));delta={role:'assistant',tool_calls:[{id:'profile-tool',type:'function',function:{name:'codemode',arguments:JSON.stringify({code:`return await tools.system_one(${JSON.stringify(request)});`})}}]};finish='tool_calls';}
    else if(!toolResult && text.includes('RUN_CODEMODE')) {delta={role:'assistant',tool_calls:[{id:'profile-native',type:'function',function:{name:'codemode',arguments:JSON.stringify({code:`const m = await models.getModelOfType("classifier","openrouter","~typesafe/jev-latest"); return await models.classify(m,${JSON.stringify({...request,state:{evidence:'PROFILE_CODEMODE_EVIDENCE'}})});`})}}]};finish='tool_calls';}
    else {if(toolResult){assert.match(JSON.stringify(body.messages.at(-1)),/wait/);assert.doesNotMatch(JSON.stringify(body.messages.at(-1)),/Script failed/);}delta={role:'assistant',content:text.includes('RUN_AGENT')?'PROFILE_AGENT_DONE':text.includes('RUN_CODEMODE')?'PROFILE_CODEMODE_DONE':'PROFILE_NEXT_DONE'};}
    res.writeHead(200,{'content-type':'text/event-stream'});const chunk={id:'profile',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]};res.write(`data: ${JSON.stringify(chunk)}\n\n`);res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:finish}]})}\n\n`);res.end('data: [DONE]\n\n');
  } catch(error){fixtureError=error;await writeFile(join(capture,'fixture-error.txt'),error.stack);res.writeHead(500);res.end('Fixture assertion failed');}});
  await new Promise(res=>server.listen(0,'127.0.0.1',res));const origin=`http://127.0.0.1:${server.address().port}`;
  const mapping=Object.fromEntries(['models','systemone','chat/completions'].map(p=>[`https://openrouter.ai/api/v1/${p}`,`${origin}/api/v1/${p}`]));
  const guard=pathToFileURL(resolve('scripts/scripted-fetch-guard.mjs')).href;
  env={...env,SYSTEM_ONE_FIXTURE_URLS:JSON.stringify([...Object.values(mapping),`${origin}/v1/chat/completions`]),SYSTEM_ONE_FIXTURE_MAPPING:JSON.stringify(mapping),NODE_OPTIONS:`--import=${guard}`,SCRIPTED_PI_API_KEY:'fixture-only'};
  process.env.SYSTEM_ONE_FIXTURE_URLS=env.SYSTEM_ONE_FIXTURE_URLS;process.env.SYSTEM_ONE_FIXTURE_MAPPING=env.SYSTEM_ONE_FIXTURE_MAPPING;
  await import(`${guard}?profile-proof`);
  const {getBuiltinClassifierModels}=await import(moduleUrl('node_modules/@earendil-works/pi-ai/dist/providers/all.js'));
  assert.ok(getBuiltinClassifierModels('openrouter').some(m=>m.id==='~typesafe/jev-latest'));
  // Test-only capture of the actual retained definition; execution stays product-owned.
  const composed=join(root,'retained.mjs');
  await writeFile(composed,`import extension from ${JSON.stringify(pathToFileURL(resolve('packages/pi-system-one/src/index.js')).href)};export default pi=>{let retained;pi.events.on('profile-retained',q=>q.provide(retained));extension(new Proxy(pi,{get(target,key){if(key==='registerTool')return tool=>{if(tool.name==='system_one')retained=tool;return target.registerTool(tool);};return Reflect.get(target,key);}}));};`);
  const extensions=[join(piRoot,'dist/extensions/codemode/index.js'),composed];
  if(personal){const gate=join(agent,'extensions/openrouter-gate');await cp(join(source,'dot_pi/private_agent/extensions/openrouter-gate'),gate,{recursive:true});await writeFile(join(gate,'config.json'),JSON.stringify({enabled:true,allowedModels:['~typesafe/jev-latest','z-ai/glm-5.3-flash']}));extensions.unshift(join(gate,'index.ts'),'/Users/cartwmic/.pi/agent/git/github.com/olixis/pi-openrouter-plus/extensions/openrouter-routing/index.ts');}
  await writeFile(join(agent,'auth.json'),JSON.stringify({[personal?'openrouter-stashed':'openrouter']:{type:'api_key',key:'fixture-only'}}));
  await mkdir(join(agent,'system-one'));await writeFile(join(agent,'system-one/preferences.json'),JSON.stringify({version:1,agentAccess:false,defaultMode:'selective',defaultClassifier:{provider:'openrouter',id:'~typesafe/jev-latest'}}));
  const runtimeModels={providers:{}};
  // Keep non-secret source model definitions, but never executable auth commands.
  for(const [id,value] of Object.entries(models.providers)){const {apiKey,...safe}=value;runtimeModels.providers[id]=safe;}
  if(!personal)runtimeModels.providers.scripted={baseUrl:`${origin}/v1`,api:'openai-completions',apiKey:'$SCRIPTED_PI_API_KEY',models:[{id:'scripted-profile',name:'Fixture chat',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:512}]};
  await writeFile(join(agent,'models.json'),JSON.stringify(runtimeModels));
  const editor=join(root,'editor.sh');await writeFile(editor,`#!/bin/sh\nprintf '%s' '${JSON.stringify({...request,state:{evidence:'PROFILE_MANUAL_PRIVATE'},questions:{...request.questions,release:{...request.questions.release,criteria:{PRIVATE_NATIVE_MANUAL_OUTPUT:'Wait',proceed:'Proceed'}}}})}' > "$1"\n`);await chmod(editor,0o700);
  await writeFile(join(agent,'settings.json'),JSON.stringify({...settings,packages:[],externalEditor:editor,quietStartup:true}));
  const probe=join(root,'probe.mjs');
  await writeFile(probe,`import assert from 'node:assert/strict';import {getSystemOneApi} from ${JSON.stringify(pathToFileURL(resolve('packages/pi-system-one/src/internal.js')).href)};
export default pi=> {
pi.registerCommand('profile-check',{handler:async(args,ctx)=>{try { let retained;pi.events.emit('profile-retained',{provide:t=>retained=t});const api=getSystemOneApi(pi); const status=await api.getStatus(ctx); assert.equal(status.agentAccess,false); const native=ctx.modelRegistry.getModelOfType('classifier','openrouter','~typesafe/jev-latest'); if(args==='allowed'){assert.ok(native); assert.ok((await ctx.modelRegistry.getAvailableOfType('classifier','openrouter')).some(m=>m.id===native.id));} else {assert.equal(native,undefined);await assert.rejects(api.evaluateManual(${JSON.stringify(request)},{},ctx));} assert.ok(retained);await assert.rejects(retained.execute('fresh-refusal',${JSON.stringify(request)},undefined,undefined,ctx),/access is off/i);if(args==='blocked'){await api.setSessionAccess(true);try{await assert.rejects(retained.execute('provider-fresh-refusal',${JSON.stringify(request)},undefined,undefined,ctx));}finally{await api.setSessionAccess(false);}}ctx.ui.notify('PROFILE_CHECK_'+args+'_DONE','info'); }catch(e){ctx.ui.notify('PROFILE_CHECK_FAILED '+e.stack,'error');throw e;} }}); };`);
  extensions.push(probe);
  const python=String.raw`import errno,os,pty,select,signal,sys,time
pid,fd=pty.fork()
if pid==0: os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
output=bytearray();cursor=0
def wait(token,timeout=25):
 global cursor
 deadline=time.time()+timeout;needle=token.encode()
 while time.time()<deadline:
  pos=output.find(needle,cursor)
  if pos>=0: cursor=pos+len(needle);return
  ready,_,_=select.select([fd],[],[],0.2)
  if ready:
   try: data=os.read(fd,8192)
   except OSError: break
   if not data: break
   output.extend(data)
 raise RuntimeError('Missing completed outer outcome '+token+'\n'+output.decode(errors='replace')[-9000:])
def send(text): os.write(fd,text.encode()+b'\r')
try:
 wait(os.environ['PROFILE_CHAT_ID'])
 send('/so on')
 # Pi can paint the model footer before enabling submission; retry Enter only.
 deadline=time.time()+20
 while output.find(b'access is on',cursor)<0 and time.time()<deadline:
  ready,_,_=select.select([fd],[],[],0.2)
  if ready:
   try: output.extend(os.read(fd,8192))
   except OSError: break
  if output.find(b'access is on',cursor)<0: os.write(fd,b'\r')
 wait('access is on')
 if os.environ['PROFILE_PERSONAL']=='1':
  send('/openrouter-sync');wait('models synced')
 send('RUN_AGENT');wait('PROFILE_AGENT_DONE')
 send('/so off');wait('access is off')
 send('/profile-check allowed');wait('PROFILE_CHECK_allowed_DONE')
 send('RUN_CODEMODE');wait('PROFILE_CODEMODE_DONE')
 send('/so ask');wait('System One request JSON')
 os.write(fd,b'\x07');wait('PROFILE_MANUAL_PRIVATE');os.write(fd,b'\r')
 wait('Classifier for this call only');os.write(fd,b'\r');wait('System One result')
 os.write(fd,b'\r');send('NEXT_ORDINARY');wait('PROFILE_NEXT_DONE')
 if os.environ['PROFILE_PERSONAL']=='1':
  send('/openrouter off');wait('OpenRouter OFF')
  send('/profile-check blocked');wait('PROFILE_CHECK_blocked_DONE')
  send('/openrouter on');wait('OpenRouter ON')
  send('/openrouter deny ~typesafe/jev-latest');wait('removed ~typesafe/jev-latest')
  send('/profile-check blocked');wait('PROFILE_CHECK_blocked_DONE')
  send('/openrouter allow ~typesafe/jev-latest');wait('allowed ~typesafe/jev-latest')
  send('/reload');wait('Reloaded keybindings, extensions')
  send('/profile-check allowed');wait('PROFILE_CHECK_allowed_DONE')
finally:
 sys.stdout.buffer.write(output);sys.stdout.flush()
 try: os.killpg(pid,signal.SIGKILL)
 except ProcessLookupError: pass
 os.close(fd)
`;
  await writeFile(join(capture,'pty.py'),python);
  const chatId=personal?'z-ai/glm-5.3-flash':'scripted-profile';
  env={...env,PROFILE_CHAT_ID:chatId,PROFILE_PERSONAL:personal?'1':'0'};
  const terminal=await run('python3',['-c',python,process.execPath,piEntry,'--no-extensions','--no-context-files','--provider',personal?'openrouter':'scripted','--model',chatId,...extensions.flatMap(p=>['--extension',p])],env,'pty',150000);
  assert.ifError(fixtureError);
  assert.match(terminal,/PROFILE_AGENT_DONE/);assert.match(terminal,/PROFILE_CODEMODE_DONE/);assert.match(terminal,/PROFILE_NEXT_DONE/);assert.match(terminal,/PRIVATE_NATIVE_MANUAL_OUTPUT/);
  assert.equal(requests.filter(r=>r.path==='/api/v1/systemone').length,3);
  const chat=requests.filter(r=>r.path.endsWith('/chat/completions'));assert.equal(chat.length,5);
  assert.ok(chat[1].body.messages.some(m=>m.role==='tool'));assert.ok(chat[3].body.messages.some(m=>m.role==='tool'));
  for(const row of [chat[1],chat[3]]){const text=JSON.stringify(row.body.messages.findLast(m=>m.role==='tool'));assert.match(text,/stopReason/);assert.match(text,/probability/);assert.match(text,/score/);assert.doesNotMatch(text,/Script failed/);}
  if(personal)assert.ok(requests.some(r=>r.path==='/api/v1/models'),'actual plus model-list refresh must reach fixture');
  assert.ok(!JSON.stringify(chat.at(-1).body.messages).includes('PROFILE_MANUAL_PRIVATE'));assert.ok(!JSON.stringify(chat.at(-1).body.messages).includes('PRIVATE_NATIVE_MANUAL_OUTPUT'));
  const sessions=[];async function collect(p){for(const e of await readdir(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())await collect(f);else if(e.name.endsWith('.jsonl'))sessions.push(await readFile(f,'utf8'));}}await collect(agent);
  assert.ok(sessions.length);assert.ok(!sessions.join('').includes('PROFILE_MANUAL_PRIVATE'));assert.ok(!sessions.join('').includes('PRIVATE_NATIVE_MANUAL_OUTPUT'));
  await writeFile(join(capture,'outcome.json'),JSON.stringify({status:'PASS',profile,completed:['actual Pi codemode nested retained system_one agent round-trip','actual native codemode while /so off','actual PTY /so ask typed success and next-turn privacy',...(personal?['actual plus refresh and gate off/deny/reload']:[])],transport:'TEST ONLY exact logical vendor-to-loopback mapping, redirects error; not live-provider proof',cleanup:true},null,2));
  console.log(JSON.stringify({status:'PASS',profile,capture}));
} catch(error){await writeFile(join(capture,'failure.txt'),error.stack);console.error(`FAILED capture preserved: ${capture}`);throw error;}
finally {await writeFile(join(capture,'requests.json'),JSON.stringify(requests,null,2));if(server)await new Promise(res=>{server.close(res);server.closeAllConnections();});await rm(root,{recursive:true,force:true});}

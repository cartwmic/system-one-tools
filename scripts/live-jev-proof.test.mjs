import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Budget,UPSTREAM,REQUIRED,CAPTURE_BINARY,sha,canonical,verifyCapture} from './live-jev-proof.mjs';
import {SLOTS,observeClassify} from './live-jev-caller.mjs';
export async function validateOffline() {
  const root=await mkdtemp(join(tmpdir(),'jev-dummy-proof-'));
  const sources=[{root:'/DUMMY/tools',identity:'sha256:'+sha('DUMMY tracked dirty index untracked tools bytes')},{root:'/DUMMY/dotfiles',identity:'sha256:'+sha('DUMMY dotfiles bytes')}];
  const rows=REQUIRED.map(id=>({id,argv:['DUMMY',id],environment:{DUMMY:'fixture-only'},inherit_environment:[],timeout_ms:1000,obligations:[id]}));
  const settings=Object.fromEntries(rows.map(r=>[r.id,{environment:r.environment,inherited_environment:{},timeout_ms:r.timeout_ms}]));
  const executables=rows.map(()=>'/DUMMY/node');
  const index={cwd:sources[0].root,repository_identity:sources[0].identity,settings,receipts:[],matrix_identity:sha(canonical({matrix:{rows},cwd:sources[0].root,settings,executables}))};
  const records=[];
  const put=(p,x)=>writeFile(p,JSON.stringify(x));
  async function bind(){const bytes=await readFile(join(root,'index.json'));await put(join(root,'jev-two-tree.json'),{format:'jev-two-tree-v1',capture_binary:CAPTURE_BINARY,before:sources,after:sources,index_sha256:sha(bytes),receipts:await Promise.all(index.receipts.map(async s=>({id:s.id,sha256:sha(await readFile(join(root,s.receipt)))})))});}
  async function negativeReceipt(key,value){const record=records[0],p=join(root,index.receipts[0].receipt),old=record[key];record[key]=value;await put(p,record);await bind();await assert.rejects(verifyCapture(root,sources,rows));record[key]=old;await put(p,record);await bind();}
  try {
    for(let n=0;n<rows.length;n++){const row=rows[n],attempt=join(root,'attempts',String(n));await mkdir(attempt,{recursive:true});const stdout='DUMMY completed toy proof\n# skipped 0\n',stderr='';await writeFile(join(attempt,'stdout'),stdout);await writeFile(join(attempt,'stderr'),stderr);
      const started={id:row.id,argv:row.argv,resolved_executable:executables[n],cwd:index.cwd,settings:settings[row.id],obligations:row.obligations,repository_before:index.repository_identity,started_at:1};
      const receipt={...started,repository_after:index.repository_identity,finished_at:2,wall_seconds:1,exit_code:0,signal:null,timed_out:false,aborted:false,spawn_error:null,capture_error:null,cleanup:'complete',stdout:'stdout',stderr:'stderr',stdout_sha256:sha(stdout),stderr_sha256:sha(stderr)};
      await put(join(attempt,'started.json'),started);await put(join(attempt,'receipt.json'),receipt);records.push(receipt);index.receipts.push({id:row.id,receipt:`attempts/${n}/receipt.json`});}
    await put(join(root,'matrix.json'),{rows});await put(join(root,'index.json'),index);await put(join(root,'state.json'),{status:'completed',cleanup:'complete',selected_count:rows.length,row_count:rows.length});await bind();
    await verifyCapture(root,sources,rows);
    await assert.rejects(verifyCapture(join(root,'missing'),sources,rows));
    for(const [k,v] of [['exit_code',1],['timed_out',true],['aborted',true],['spawn_error','DUMMY'],['capture_error','DUMMY'],['cleanup','pending'],['signal',9],['repository_after','sha256:'+sha('drift')],['settings',{}],['resolved_executable',null]])await negativeReceipt(k,v);
    await assert.rejects(verifyCapture(root,[{...sources[0],identity:'sha256:'+sha('source drift')},sources[1]],rows));
    await writeFile(join(root,'attempts/0/stdout'),'broken');await assert.rejects(verifyCapture(root,sources,rows));await writeFile(join(root,'attempts/0/stdout'),'DUMMY completed toy proof\n# skipped 0\n');
    await writeFile(join(root,'attempts/0/receipt.json'),JSON.stringify({...records[0],exit_code:1}));await assert.rejects(verifyCapture(root,sources,rows));await put(join(root,'attempts/0/receipt.json'),records[0]);
    await put(join(root,'state.json'),{status:'failed',cleanup:'complete',selected_count:rows.length,row_count:rows.length});await assert.rejects(verifyCapture(root,sources,rows));await put(join(root,'state.json'),{status:'completed',cleanup:'complete',selected_count:rows.length,row_count:rows.length});
    const original=await readFile(join(root,'index.json'));await writeFile(join(root,'index.json'),Buffer.concat([original,Buffer.from('\n')]));await assert.rejects(verifyCapture(root,sources,rows));await writeFile(join(root,'index.json'),original);
    index.receipts.reverse();await put(join(root,'index.json'),index);await bind();await assert.rejects(verifyCapture(root,sources,rows));index.receipts.reverse();await put(join(root,'index.json'),index);await bind();
    index.receipts.pop();await put(join(root,'index.json'),index);await bind();await assert.rejects(verifyCapture(root,sources,rows));
    const six=new Budget();for(const slot of SLOTS){six.begin(slot);six.transport(UPSTREAM);six.finish(true);}assert.equal(six.total,6);assert.equal(six.slots.length,6);assert.throws(()=>six.begin('seventh'));
    const cap=new Budget();for(const slot of SLOTS){cap.begin(slot);for(let i=0;i<3;i++)cap.transport(UPSTREAM);assert.throws(()=>cap.transport(UPSTREAM));cap.finish(true);}assert.equal(cap.total,18);assert.throws(()=>cap.begin('nineteenth'));
    // Independent total cap, not merely a consequence of per-slot cap.
    const total=new Budget();total.total=18;total.begin('DUMMY');assert.throws(()=>total.transport(UPSTREAM));assert.equal(total.active.attempts,0);
    const stop=new Budget();stop.begin(SLOTS[0]);stop.transport(UPSTREAM);stop.finish(false);assert.throws(()=>stop.begin(SLOTS[1]));assert.equal(stop.total,1);assert.equal(stop.slots.length,1);
    const target=new Budget();target.begin(SLOTS[0]);assert.throws(()=>target.transport('https://DUMMY.invalid/forbidden'));assert.equal(target.total,0);
    const result={stopReason:'stop',answers:{color:{choice:'red'}},usage:{input:1,output:2},extra:'DUMMY'};let calls=0,recorded;assert.equal(await observeClassify(async()=>{calls++;return result;},[],async r=>{recorded=r;}),result);assert.equal(calls,1);assert.equal(recorded.stopReason,'stop');
    const error=new Error('DUMMY secret error');await assert.rejects(observeClassify(async()=>{throw error;},[],async r=>{recorded=r;}),e=>e===error);assert.deepEqual(recorded,{stopReason:'exception'});
    return {status:'PASS',fixture:'synthetic DUMMY capture/streams/two-tree byte identities',remote_requests:0,credentials_read:0,controls:['six sequential success slots','third attempt/fourth refusal','eighteenth total/nineteenth refusal','first terminal stop','unexpected URL refused without transport','missing/failed/timed-out/aborted/spawn/capture/cleanup admission','stream/receipt/index/source/order/settings refusal','unchanged observer return and exception']};
  }finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]?.endsWith('live-jev-proof.test.mjs'))test('live Jev offline admission and exact controls',async()=>{await validateOffline();});

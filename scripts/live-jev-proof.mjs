// Test-local proof admission and budget. No credential or transport access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, lstat, stat, readlink, realpath } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
export const CAPTURE_BINARY={path:'/Users/cartwmic/.local/share/mise/installs/loop-engine/0.23.0/loop-engine',sha256:'196fbe2df3ad4afbf1d0ac96bcfe24498a30f18063edbf819f8dc6c3409f4a0f',version:'0.23.0'};
export const UPSTREAM = 'https://openrouter.ai/api/v1/systemone';
export const REQUIRED = ['P-install','P-root-check','P-caller-journey','P-real-tui','P-package-matrix','P-gate-unit','P-gate-personal','P-gate-work','P-profile-personal','P-profile-work','P-native-profile-personal','P-native-profile-work','P-live-validator','P-tools-status','P-tools-diff-check','P-dotfiles-status','P-dotfiles-diff-check'];
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const json = async p => JSON.parse(await readFile(p,'utf8'));
// Exact common capture repository identity algorithm, including dirty worktree,
// index entries/modes, symlink targets and all nonignored untracked source bytes.
export async function sourceIdentity(root) {
  root=await realpath(root); const digest=createHash('sha256');
  const add = value => {const b=Buffer.from(value);const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(b.length));digest.update(length);digest.update(b);};
  const git = args => execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024});
  add(git(['rev-parse','HEAD']));add(git(['ls-files','--stage','-z']));add(git(['status','--porcelain=v1','--untracked-files=all','-z']));
  const names=[...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean))].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  for(const name of names){add(name);const p=join(root,name);let stat;try{stat=await lstat(p);}catch(e){if(e.code!=='ENOENT')throw e;add('deleted');continue;}
    if(stat.isSymbolicLink()){add('symlink');add(await readlink(p));}else{assert.ok(stat.isFile(),'unsupported source entry');add(String(stat.mode&0o777));add(await readFile(p));}}
  return {root,identity:`sha256:${digest.digest('hex')}`};
}
export async function collectSources(roots) {assert.equal(roots.length,2);return Promise.all(roots.map(sourceIdentity));}
// DRIVER collects before matrix, then after matrix. Output MUST be outside roots.
// The native capture format is untouched; this supplemental object binds both trees.
export async function bindSupplement(dir, before, roots) {
  const after=await collectSources(roots);assert.deepEqual(after,before,'source drift across proof');
  const indexBytes=await readFile(join(dir,'index.json'));const index=JSON.parse(indexBytes);
  return {format:'jev-two-tree-v1',capture_binary:CAPTURE_BINARY,before,after,index_sha256:sha(indexBytes),receipts:await Promise.all(index.receipts.map(async s=>({id:s.id,sha256:sha(await readFile(resolve(dir,s.receipt)))})))};
}
async function confined(base, path) {const p=await realpath(resolve(base,path));assert.ok(p.startsWith((await realpath(base))+sep),'capture path escapes');return p;}
export async function admit(dir, roots, expectedRows) {
  assert.equal(sha(await readFile(CAPTURE_BINARY.path)),CAPTURE_BINARY.sha256,'unpinned capture binary');
  assert.match(execFileSync(CAPTURE_BINARY.path,['--version'],{encoding:'utf8'}),/^0\.23\.0\s*$/);
  const admission=await verifyCapture(dir,await collectSources(roots),expectedRows);
  const index=await json(join(dir,'index.json'));
  for(let n=0;n<expectedRows.length;n++){
    const row=expectedRows[n];for(const key of row.inherit_environment??[])assert.equal(index.settings[row.id].inherited_environment[key],process.env[key]??null,'inherited setting changed');
    const command=row.argv[0],candidates=command.includes('/')?[resolve(index.cwd,command)]:(row.environment?.PATH??process.env.PATH??'').split(':').map(p=>resolve(index.cwd,p,command));let executable=null;
    for(const p of candidates){try{const s=await stat(p);if(s.isFile()&&(s.mode&0o111)){executable=await realpath(p);break;}}catch{}}
    const receipt=await json(resolve(dir,index.receipts[n].receipt));assert.equal(receipt.resolved_executable,executable,'resolved executable changed');
  }
  return admission;
}
export async function verifyCapture(dir, sources, expectedRows) {
  const supplemental=await json(join(dir,'jev-two-tree.json'));
  assert.equal(supplemental.format,'jev-two-tree-v1');assert.deepEqual(supplemental.capture_binary,CAPTURE_BINARY);assert.deepEqual(supplemental.before,supplemental.after);
  assert.deepEqual(sources,supplemental.after,'source drift at admission');
  const indexBytes=await readFile(join(dir,'index.json'));assert.equal(sha(indexBytes),supplemental.index_sha256,'index digest');
  const index=JSON.parse(indexBytes), matrix=await json(join(dir,'matrix.json'));
  assert.deepEqual(matrix.rows,expectedRows,'wrong proof matrix');assert.deepEqual(matrix.rows.map(r=>r.id),REQUIRED,'incomplete/reordered proof selection');
  assert.equal(index.cwd,supplemental.after[0].root);assert.equal(index.repository_identity,supplemental.after[0].identity);
  assert.deepEqual(index.receipts.map(s=>s.id),REQUIRED);assert.deepEqual(supplemental.receipts.map(s=>s.id),REQUIRED);
  const settings=Object.fromEntries(matrix.rows.map(r=>{const inherited=index.settings?.[r.id]?.inherited_environment;assert.deepEqual(Object.keys(inherited??{}).sort(),[...(r.inherit_environment??[])].sort());for(const v of Object.values(inherited))assert.ok(v===null||typeof v==='string');return [r.id,{environment:r.environment??{},inherited_environment:inherited,timeout_ms:r.timeout_ms}];}));
  assert.deepEqual(index.settings,settings);
  const executables=[];
  for(let n=0;n<REQUIRED.length;n++){
    const row=matrix.rows[n],path=await confined(join(dir,'attempts'),resolve(dir,index.receipts[n].receipt));const bytes=await readFile(path);assert.equal(sha(bytes),supplemental.receipts[n].sha256,'receipt digest');
    const receipt=JSON.parse(bytes),started=await json(join(dirname(path),'started.json'));
    for(const key of ['id','argv','resolved_executable','cwd','settings','obligations','repository_before','started_at'])assert.deepEqual(started[key],receipt[key],`started mismatch ${key}`);
    assert.equal(receipt.id,row.id);assert.deepEqual(receipt.argv,row.argv);assert.deepEqual(receipt.obligations,row.obligations);assert.deepEqual(receipt.settings,settings[row.id]);assert.equal(receipt.cwd,index.cwd);
    assert.equal(receipt.repository_before,index.repository_identity);assert.equal(receipt.repository_after,index.repository_identity);
    assert.equal(receipt.exit_code,0);assert.equal(receipt.signal,null);assert.equal(receipt.timed_out,false);assert.equal(receipt.aborted,false);assert.equal(receipt.spawn_error,null);assert.equal(receipt.capture_error,null);assert.equal(receipt.cleanup,'complete');
    assert.ok(Number.isFinite(receipt.started_at)&&Number.isFinite(receipt.finished_at)&&receipt.finished_at>=receipt.started_at);assert.ok(Number.isFinite(receipt.wall_seconds)&&receipt.wall_seconds>=0);assert.ok(typeof receipt.resolved_executable==='string'&&receipt.resolved_executable.startsWith('/'));executables.push(receipt.resolved_executable);
    for(const stream of ['stdout','stderr']){const data=await readFile(await confined(dirname(path),receipt[stream]));assert.equal(sha(data),receipt[stream+'_sha256'],'stream digest');assert.doesNotMatch(data.toString(),/# SKIP\b|# skipped [1-9]|"status"\s*:\s*"(?:SKIP|BLOCKED|FAIL)"/i,'incomplete proof');}
  }
  const normalized={rows:matrix.rows.map(r=>({environment:{},inherit_environment:[],...r}))};
  assert.equal(index.matrix_identity,sha(canonical({matrix:normalized,cwd:index.cwd,settings,executables})),'matrix identity');
  const state=await json(join(dir,'state.json'));assert.equal(state.cleanup,'complete');assert.equal(state.status,'completed');assert.equal(state.selected_count,REQUIRED.length);assert.equal(state.row_count,REQUIRED.length);
  return {index_sha256:supplemental.index_sha256,sources:supplemental.after};
}
export class Budget {
  constructor(){this.total=0;this.slots=[];this.active=null;this.stopped=false;}
  begin(id){assert.ok(!this.stopped&&!this.active&&this.slots.length<6,'matrix stopped/overlap/exhausted');this.active={id,attempts:0};}
  transport(url){assert.equal(url,UPSTREAM,'unexpected upstream');assert.ok(this.active&&!this.stopped,'no active evaluation');assert.ok(this.active.attempts<3&&this.total<18,'transport cap');this.active.attempts++;this.total++;}
  finish(success){assert.ok(this.active);this.slots.push({...this.active,success});this.active=null;if(!success)this.stopped=true;}
}

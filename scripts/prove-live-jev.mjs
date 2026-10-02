#!/usr/bin/env node
// Explicit T6-only paid executor. Never in npm test/check.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {admit,Budget,REQUIRED,sha} from './live-jev-proof.mjs';
import {SLOTS,runSlot,installedPi} from './live-jev-caller.mjs';
import {transportTrap} from './native-profile-transport-trap.mjs';
export const ARTIFACT_ROOT='/Volumes/Workshop/macbook/loop-engine/runs/run-1790885328723869000-1-1157';
export const ROOTS=['/Volumes/Workshop/macbook/git/system-one-tools-wt-native-classifiers-20260930-204317-bc9b38','/Volumes/Workshop/macbook/git/dotfiles-wt-system-one-native-20261001-063729-c338e3'];
// DRIVER calls this to produce the capture-matrix input. No invocation performed.
export async function finalMatrix({timeout_ms=600000,environment={},inherit_environment=['PATH']}={}) {
  assert.ok(Number.isInteger(timeout_ms)&&timeout_ms>0);for(const k of [...Object.keys(environment),...inherit_environment])assert.doesNotMatch(k,/API_KEY|TOKEN|SECRET|CREDENTIAL/i);
  const bytes=await readFile(ARTIFACT_ROOT+'/plan.json');assert.equal(sha(bytes),'83183aad63425a156492f75de08034083a6af1cc2769fad2dda02242324b1f4e','changed plan contract');
  const plan=JSON.parse(bytes);return {rows:REQUIRED.map(id=>{const proof=plan.proof_commands.find(p=>p.id===id);assert.ok(proof);return {id,argv:[proof.command,...proof.args],environment,inherit_environment,timeout_ms,obligations:[proof.obligation]};})};
}
export async function main(args) {
  if(args.length===1&&args[0]==='--validate-only') {
    const {validateOffline}=await import('./live-jev-proof.test.mjs');console.log(JSON.stringify(await validateOffline()));return;
  }
  assert.equal(args.length,3,'Usage: --validate-only OR --approved-six-evaluation-jev --scripted-proof DIR');assert.equal(args[0],'--approved-six-evaluation-jev');assert.equal(args[1],'--scripted-proof');
  assert.equal(resolve('.'),ROOTS[0],'wrong implementation cwd');
  const dir=resolve(args[2]);const matrix=JSON.parse(await readFile(dir+'/matrix.json','utf8'));
  // Timeout/environment are driver choices, but every row must share the same
  // declared settings and exact frozen command/obligation/order.
  const first=matrix.rows[0];const expected=(await finalMatrix(first)).rows;
  const admission=await admit(dir,ROOTS,expected);
  const pi=await installedPi();await transportTrap(pi.piRoot); // local trap before SDK/Pi setup
  // Only now access the approved runtime credential. No key files/op/executable
  // credential expressions, copies to auth.json, headers or error bodies logged.
  const key=process.env.OPENROUTER_API_KEY;assert.ok(typeof key==='string'&&key.trim()&&key!=='fixture-only','T6 must supply OPENROUTER_API_KEY at runtime');
  const budget=new Budget(),outcomes=[];
  for(const slot of SLOTS){budget.begin(slot);let result;try{result=await runSlot({slot,budget,...pi,key});}catch{result={stopReason:'caller-failure'};}
    const answer=result.answers?.color,type=slot.split('-')[1];const typed=type==='choice'?['red','blue'].includes(answer?.choice):type==='bool'?Number.isFinite(answer?.probability)&&answer.probability>=0&&answer.probability<=1:Number.isFinite(answer?.score);
    const success=result.stopReason==='stop'&&typed&&budget.active.attempts>0;budget.finish(success);outcomes.push({slot,...result,success,attempts:budget.slots.at(-1).attempts});if(!success)break;
  }
  console.log(JSON.stringify({status:budget.stopped?'TERMINAL_STOP':'PASS',selection:{provider:'openrouter',model:'~typesafe/jev-latest'},credential_source:'runtime OPENROUTER_API_KEY environment (value never recorded)',admission,outcomes,transport_requests:budget.total,terminal_stop:budget.stopped,unrun:SLOTS.slice(outcomes.length)}));
  if(budget.stopped)process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).catch(()=>{console.error('Live Jev proof refused or failed; no unsanitized error details emitted.');process.exitCode=1;});

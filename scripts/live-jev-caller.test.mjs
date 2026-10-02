import test from 'node:test';
import assert from 'node:assert/strict';
import {Budget,UPSTREAM} from './live-jev-proof.mjs';
import {runSlot,installedPi} from './live-jev-caller.mjs';
import {transportTrap} from './native-profile-transport-trap.mjs';
test('real Pi toy tool and PTY manual complete; manual terminal failure stops next slot', {timeout:240000},async()=>{
  const pi=await installedPi();await transportTrap(pi.piRoot);
  const budget=new Budget();let requests=0;
  const forward=async(url)=>{assert.equal(url,UPSTREAM);requests++;if(requests<=2)return new Response('{"error":"DUMMY transient"}',{status:503,headers:{'content-type':'application/json','retry-after':'0'}});return new Response(JSON.stringify({answers:{color:{type:'noul',noul:0.9}},usage:{input_tokens:2,output_tokens:1}}),{headers:{'content-type':'application/json'}});};
  for(const slot of ['tool-bool','manual-bool']){budget.begin(slot);const result=await runSlot({slot,budget,...pi,key:'fixture-only',dummyDebug:true,forward});assert.equal(result.stopReason,'stop');assert.equal(result.answers.color.probability,0.9);budget.finish(true);}
  budget.begin('manual-score');const failure=await runSlot({slot:'manual-score',budget,...pi,key:'fixture-only',dummyDebug:true,forward:async(url)=>{assert.equal(url,UPSTREAM);requests++;return new Response('{"error":"DUMMY unauthorized"}',{status:401,headers:{'content-type':'application/json'}});}});assert.notEqual(failure.stopReason,'stop');budget.finish(false);assert.throws(()=>budget.begin('tool-score'));assert.equal(requests,5);assert.equal(budget.total,5);assert.equal(budget.slots[0].attempts,3);
  const terminal=new Budget();terminal.begin('tool-bool');let terminalCalls=0;const third=await runSlot({slot:'tool-bool',budget:terminal,...pi,key:'fixture-only',dummyDebug:true,forward:async(url)=>{assert.equal(url,UPSTREAM);terminalCalls++;return new Response('{"error":"DUMMY transient"}',{status:503,headers:{'content-type':'application/json','retry-after':'0'}});}});assert.notEqual(third.stopReason,'stop');terminal.finish(false);assert.equal(terminalCalls,3);assert.equal(terminal.total,3);assert.throws(()=>terminal.begin('manual-bool'));
});

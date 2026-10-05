import test from 'node:test';import assert from 'node:assert/strict';import {watchWallet,WALLET_UPDATED_EVENT} from '../../../lib/owned-wallet-poll.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function surfaces(){const document=new EventTarget(),window=new EventTarget(),timers=new Map();let id=0;document.hidden=false;window.setTimeout=f=>{timers.set(++id,f);return id};window.clearTimeout=id=>timers.delete(id);return {document,window,timers};}
test('wallet refreshes after settlement, serializes reads and ignores late unmounted response',async()=>{
 const s=surfaces();let complete,calls=0,values=[];const stop=watchWallet({...s,read:()=>{calls++;return new Promise(r=>complete=r)},onValue:v=>values.push(v),onError:()=>assert.fail()});assert.equal(calls,1);
 s.window.dispatchEvent(new Event(WALLET_UPDATED_EVENT));assert.equal(calls,1);complete(30);await tick();assert.equal(calls,2);assert.deepEqual(values,[30]);stop();complete(15);await tick();assert.deepEqual(values,[30]);assert.equal(s.timers.size,0);
});
test('hidden tabs do not poll and resume on visibility; failure keeps watcher alive',async()=>{
 const s=surfaces();s.document.hidden=true;let calls=0,errors=0;const stop=watchWallet({...s,read:async()=>{calls++;throw Error('offline')},onValue:()=>assert.fail(),onError:()=>errors++});assert.equal(calls,0);s.document.hidden=false;s.document.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(calls,1);assert.equal(errors,1);assert.equal(s.timers.size,1);s.document.hidden=true;s.document.dispatchEvent(new Event('visibilitychange'));assert.equal(s.timers.size,0);stop();
});

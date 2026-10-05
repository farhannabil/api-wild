import test from 'node:test';import assert from 'node:assert/strict';
import {createSupplierDebitSweep,createSupplierDebitSweepFromEnv} from '../runtime/supplier-debit-sweep.mjs';
import {createSupplierPendingList} from '../runtime/supplier-pending-list.mjs';
const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='test:supabase:'+key,secretKey='sb_secret_syntheticFixtureOnly000000';
const rows=Array.from({length:5},(_,i)=>({owner,requestId:'bbbbbbbb-bbbb-4bbb-8bbb-'+String(i+1).padStart(12,'0'),createdAt:'2026-10-05T10:00:00.123456+00:00'}));
test('disabled sweep has no network, timer or configuration requirement',async()=>{const worker=createSupplierDebitSweepFromEnv({fetchImpl:()=>assert.fail(),setTimer:()=>assert.fail()});worker.start();assert.equal(worker.enabled,false);assert.deepEqual(await worker.runPass(),{disabled:true});await worker.stop();});
test('one finite pass advances past failures, max5, and wraps after the last page',async()=>{
 const cursors=[],attempted=[];let page=0;const worker=createSupplierDebitSweep({listPending:async cursor=>{cursors.push(cursor);return page++===0?rows:[];},reconcile:async q=>{attempted.push(q);if(attempted.length===2)throw Error('held');return {reconciled:attempted.length===1};}});
 const result=await worker.runPass();assert.equal(result.attempted,5);assert.equal(result.reconciled,1);assert.equal(result.held,4);assert.equal(attempted.length,5);
 await worker.runPass();await worker.runPass();assert.deepEqual(cursors,[null,{createdAt:rows[4].createdAt,requestId:rows[4].requestId},null]);await worker.stop();
});
test('concurrent ticks share one in-flight pass; next timer is scheduled only after completion',async()=>{
 let release,calls=0;const timers=[];const worker=createSupplierDebitSweep({listPending:()=>new Promise(r=>{calls++;release=r;}),reconcile:()=>assert.fail(),setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:()=>{}});
 worker.start();worker.start();assert.equal(timers.length,1);const tick=timers[0].fn();const first=worker.runPass(),second=worker.runPass();assert.equal(first,second);assert.equal(calls,1);assert.equal(timers.length,1);
 release([]);await tick;await first;assert.equal(timers.length,2);assert.equal(timers[1].ms,60000);await worker.stop();
});
test('stop aborts the pass and cannot start the next candidate or timer',async()=>{
 let release,attempts=0;const timerIds=[];const worker=createSupplierDebitSweep({listPending:async()=>rows,reconcile:()=>{attempts++;return new Promise(r=>release=r);},setTimer:()=>1,clearTimer:id=>timerIds.push(id)});
 worker.start();const pass=worker.runPass();await new Promise(r=>setImmediate(r));const stop=worker.stop();release({reconciled:false});await pass;await stop;assert.equal(attempts,1);assert.deepEqual(timerIds,[1]);assert.deepEqual(await worker.runPass(),{stopped:true});
});
test('list errors and oversized batches never dispatch reconciliation or expose raw errors',async()=>{
 for(const listPending of [async()=>{throw Error('private secret detail');},async()=>[...rows,rows[0]]]){const output=[];const worker=createSupplierDebitSweep({listPending,reconcile:()=>assert.fail(),write:x=>output.push(x)});assert.equal((await worker.runPass()).scanUnavailable,true);assert.ok(!JSON.stringify(output).includes('private'));await worker.stop();}
});
test('pending list is fixed, bounded, mode-scoped and preserves precise database cursor',async()=>{
 const calls=[];const list=createSupplierPendingList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(rows);}});
 assert.deepEqual(await list(null),rows);assert.equal(calls[0].url,'https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/apiwild_supplier_pending_list');assert.equal(calls[0].init.redirect,'error');assert.deepEqual(JSON.parse(calls[0].init.body),{p_billing_mode:'test',p_key_references:[key],p_after_created_at:null,p_after_id:null});
 for(const bad of [[{...rows[0],owner:'live:supabase:'+key}],[{...rows[0],owner:owner+':extra'}],[{...rows[0],extra:'private'}],[...rows,rows[0]],[rows[1],rows[0]]])await assert.rejects(createSupplierPendingList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async()=>Response.json(bad)})(null));
});

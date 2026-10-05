import test from 'node:test';import assert from 'node:assert/strict';
import {createReservationExpiryList,createReservationExpirySweep,createReservationExpirySweepFromEnv} from '../runtime/reservation-expiry-sweep.mjs';
const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='test:supabase:'+key,secretKey='sb_secret_syntheticFixtureOnly000000';
const rows=Array.from({length:5},(_,i)=>({owner,requestId:'bbbbbbbb-bbbb-4bbb-8bbb-'+String(i+1).padStart(12,'0'),expiresAt:'2026-10-05T10:00:00.123456+00:00',version:0}));
test('disabled expiry has no credential/network/timer requirements',async()=>{const worker=createReservationExpirySweepFromEnv({fetchImpl:()=>assert.fail(),setTimer:()=>assert.fail()});worker.start();assert.equal(worker.enabled,false);assert.deepEqual(await worker.runPass(),{disabled:true});await worker.stop();});
test('finite pass max5, failure/CAS race remains unchanged, cursor advances and wraps',async()=>{
 const cursors=[],attempts=[];let page=0;const worker=createReservationExpirySweep({listExpired:async cursor=>{cursors.push(cursor);return page++===0?rows:[];},expire:async row=>{attempts.push(row);if(attempts.length===2)throw Error('private detail');return {cancelled:attempts.length===1};}});
 assert.deepEqual(await worker.runPass(),{attempted:5,cancelled:1,unchanged:4,automaticRetry:false});assert.equal(attempts.length,5);await worker.runPass();await worker.runPass();assert.deepEqual(cursors,[null,{expiresAt:rows[4].expiresAt,requestId:rows[4].requestId},null]);await worker.stop();
});
test('concurrent ticks/manual passes share one promise, next timer follows completion only',async()=>{
 let release,calls=0;const timers=[];const worker=createReservationExpirySweep({listExpired:()=>new Promise(r=>{calls++;release=r;}),expire:()=>assert.fail(),setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:()=>{}});
 worker.start();worker.start();const tick=timers[0].fn(),first=worker.runPass(),second=worker.runPass();assert.equal(first,second);assert.equal(calls,1);assert.equal(timers.length,1);release([]);await first;await tick;assert.equal(timers.length,2);assert.equal(timers[1].ms,60000);await worker.stop();
});
test('stop aborts current pass and prevents later candidates or restart',async()=>{
 let release,attempts=0;const cleared=[];const worker=createReservationExpirySweep({listExpired:async()=>rows,expire:(row,{signal})=>{attempts++;assert.equal(signal.aborted,false);return new Promise(r=>release=r);},setTimer:()=>1,clearTimer:id=>cleared.push(id)});
 worker.start();const pass=worker.runPass();await new Promise(r=>setImmediate(r));const stop=worker.stop();release({cancelled:false});await pass;await stop;assert.equal(attempts,1);assert.deepEqual(cleared,[1]);worker.start();assert.deepEqual(await worker.runPass(),{stopped:true});
});
test('failed or oversized scans never attempt expiry and do not expose errors',async()=>{
 for(const listExpired of [async()=>{throw Error('private secret');},async()=>[...rows,rows[0]]]){const output=[];const worker=createReservationExpirySweep({listExpired,expire:()=>assert.fail(),write:r=>output.push(r)});assert.equal((await worker.runPass()).scanUnavailable,true);assert.equal(output[0].attempted,0);assert.ok(!JSON.stringify(output).includes('secret'));await worker.stop();}
});
test('fixed RPC list is mode/key scoped, max5, preserves microsecond cursor and version',async()=>{
 const calls=[];const list=createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(rows);}});assert.deepEqual(await list(null),rows);assert.equal(calls[0].url,'https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/apiwild_reservation_expiry_list');assert.equal(calls[0].init.redirect,'error');assert.deepEqual(JSON.parse(calls[0].init.body),{p_billing_mode:'test',p_key_references:[key],p_after_expires_at:null,p_after_id:null});
 const cursor={expiresAt:rows[0].expiresAt,requestId:rows[0].requestId};const next=createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async(url,init)=>{assert.equal(JSON.parse(init.body).p_after_expires_at,cursor.expiresAt);return Response.json(rows.slice(1));}});assert.equal((await next(cursor)).length,4);
});
test('invalid mode/key/credential/cursor rejects; no broad unscoped scan',async()=>{
 for(const patch of [{billingMode:'any'},{keyReferences:[]},{keyReferences:[key,key]},{keyReferences:[key,key,key]},{secretKey:'bad'}])assert.throws(()=>createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],...patch}));
 const list=createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:()=>assert.fail()});for(const cursor of [{expiresAt:'bad',requestId:key},{expiresAt:rows[0].expiresAt,requestId:key,extra:true},{}])await assert.rejects(list(cursor));
});
test('foreign owners, reordered/duplicate IDs, malformed versions and unknown metadata reject whole batch',async()=>{
 for(const bad of [[{...rows[0],owner:'live:supabase:'+key}],[{...rows[0],owner:owner+':extra'}],[{...rows[0],version:-1}],[{...rows[0],version:'0'}],[{...rows[0],version:Number.MAX_SAFE_INTEGER}],[{...rows[0],extra:'private'}],[...rows,rows[0]],[rows[1],rows[0]],[rows[0],rows[0]]])await assert.rejects(createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async()=>Response.json(bad)})(null));
});
test('HTTP failure, redirect, wrong type and oversized response reject without follow-up',async()=>{
 for(const response of [new Response('private',{status:503}),new Response('[]',{headers:{'content-type':'text/html'}}),new Response('[]',{headers:{'content-type':'application/json','content-length':'9000'}}),new Response(' '.repeat(8193),{headers:{'content-type':'application/json'}})])await assert.rejects(createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async()=>response})(null));
 const redirected=Response.json([]);Object.defineProperty(redirected,'redirected',{value:true});await assert.rejects(createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:async()=>redirected})(null));
});
test('aborted scan has no network',async()=>{const controller=new AbortController();controller.abort();await assert.rejects(createReservationExpiryList({secretKey,billingMode:'test',keyReferences:[key],fetchImpl:()=>assert.fail()})(null,{signal:controller.signal}));});
test('production factory uses only safe list and existing expiry CAS, branded logs contain no identity',async()=>{
 const output=[],calls=[];const worker=createReservationExpirySweepFromEnv({env:{APIWILD_RESERVATION_EXPIRY_ENABLED:'true',APIWILD_BILLING_MODE:'test',SUPABASE_SECRET_KEY:secretKey,APIWILD_SUPPLIER_BINDINGS_JSON:JSON.stringify({[key]:{}})},fetchImpl:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});if(url.endsWith('apiwild_reservation_expiry_list'))return Response.json([rows[0]]);assert.ok(url.endsWith('apiwild_gateway_expire'));assert.deepEqual(JSON.parse(init.body),{p_owner:owner,p_id:rows[0].requestId,p_expected_version:0});return Response.json({cancelled:true,record:{id:rows[0].requestId,user_id:owner,state:'cancelled',version:1,supplier_pending:false,cost_usd_micros:0,cost_cny_micros:0,observed_cny_micros:0,pricing_bound_exceeded:false}});},write:r=>output.push(r)});
 assert.equal((await worker.runPass()).cancelled,1);assert.equal(calls.length,2);assert.ok(!JSON.stringify(output).includes(owner));assert.ok(calls.every(r=>r.url.startsWith('https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/')));await worker.stop();
});

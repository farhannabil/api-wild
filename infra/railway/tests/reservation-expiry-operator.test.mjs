import test from 'node:test';import assert from 'node:assert/strict';
import {runReservationExpiryOperator as run} from '../runtime/reservation-expiry-operator.mjs';
const owner='test:supabase:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const argv=['--execute','--owner',owner,'--request',id,'--version','0'];
const env={SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',APIWILD_RESERVATION_EXPIRY_ENABLED:'true'};
const record=(patch={})=>({id,user_id:owner,state:'cancelled',version:1,supplier_pending:false,cost_usd_micros:0,cost_cny_micros:0,observed_cny_micros:0,pricing_bound_exceeded:false,...patch});
test('local check, missing secret and disabled execution never make a request',async()=>{
 for(const [args,config,want] of [[['--check',...argv.slice(1)],env,0],[argv,{},3],[argv,{...env,APIWILD_RESERVATION_EXPIRY_ENABLED:'false'},3]]){
  const out=[];assert.equal(await run({argv:args,env:config,fetchImpl:()=>assert.fail('network'),write:v=>out.push(v)}),want);
  assert.equal(JSON.stringify(out).includes(env.SUPABASE_SECRET_KEY),false);
 }
});
test('one fixed RPC cancels only the exact SQL-confirmed request and emits no record data',async()=>{
 let calls=0;const out=[];const exit=await run({argv,env,write:v=>out.push(v),fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/apiwild_gateway_expire');
  assert.deepEqual(JSON.parse(init.body),{p_owner:owner,p_id:id,p_expected_version:0});assert.equal(init.redirect,'error');
  assert.equal(init.headers.authorization,undefined);return Response.json({cancelled:true,record:record({result_json:{private:'not output'}})});
 }});assert.equal(exit,0);assert.equal(calls,1);assert.deepEqual(out,[{cancelled:true,status:'expired-never-dispatched',automaticRetry:false}]);
});
test('executing, uncertain and supplier-pending records remain held with no followup',async()=>{
 for(const patch of [{state:'executing'},{state:'uncertain'},{state:'succeeded',supplier_pending:true,cost_usd_micros:1}]){
  let calls=0;const out=[];assert.equal(await run({argv,env,write:v=>out.push(v),fetchImpl:async()=>{calls++;return Response.json({cancelled:false,record:record(patch)});}}),2);
  assert.equal(calls,1);assert.equal(out[0].status,'held-for-reconciliation');assert.equal(out[0].automaticRetry,false);
 }
});
test('wrong owner/id/version or claimed cancellation of liability never confirms release',async()=>{
 for(const patch of [{user_id:owner+':extra'},{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},{version:2},{state:'executing'},{supplier_pending:true},{cost_cny_micros:1}]){
  assert.equal(await run({argv,env,fetchImpl:async()=>Response.json({cancelled:true,record:record(patch)})}),3);
 }
});
test('arguments cannot override endpoint, identity, state, expected version or enable flag',async()=>{
 for(const args of [[...argv,'--force'],[...argv.slice(0,6),'1e3'],[...argv.slice(0,6),'-1'],[...argv.slice(0,6),'9007199254740991'],['--execute','--owner',owner+':extra',...argv.slice(3)]]){
  assert.equal(await run({argv:args,env,fetchImpl:()=>assert.fail('network')}),3);
 }
});
test('unknown, oversized, redirected and stalled outcomes stay unconfirmed with no retry or secret echo',async()=>{
 for(const fetchImpl of [async()=>new Response('PRIVATE',{status:503}),async()=>Response.json({cancelled:true,record:record()},{headers:{'content-length':'9000'}}),
  async()=>{const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;},()=>new Promise(()=>{}),
  async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})]){
  let calls=0;const out=[];assert.equal(await run({argv,env,timeoutMs:20,fetchImpl:(...args)=>{calls++;return fetchImpl(...args);},write:v=>out.push(v)}),3);
  assert.equal(calls,1);assert.equal(out[0].status,'unconfirmed');assert.equal(JSON.stringify(out).includes('PRIVATE'),false);
 }
});

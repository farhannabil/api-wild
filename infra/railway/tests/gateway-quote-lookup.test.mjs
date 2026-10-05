import test from 'node:test';import assert from 'node:assert/strict';
import {createGatewayRpc,SUPABASE_ORIGIN} from '../runtime/supabase-gateway-rpc.mjs';
const customer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',budget='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const input={keyId:null,requestKey:'fixture_request_0001',payloadHash:'a'.repeat(64),capability:'chat',model:'deepseek-v4-flash'};
const quote={providerBudgetId:budget,model:input.model,rateVersion:'fixture:ds26:off_peak',reservedUsdMicros:10,reservedCnyMicros:20};
async function fixture(response){const calls=[];const rpc=createGatewayRpc({supabaseOrigin:SUPABASE_ORIGIN,secretKey:'sb_secret_syntheticFixture000000',publishableKey:'sb_publishable_syntheticFixture000000',billingMode:'test',fetchImpl:async(url,init)=>{
 calls.push({url,init});if(url.endsWith('/auth/v1/user'))return Response.json({id:customer,email:'fixture@example.test',email_confirmed_at:'2026-10-05T00:00:00Z',is_anonymous:false});
 assert.equal(url,SUPABASE_ORIGIN+'/rest/v1/rpc/apiwild_gateway_quote_lookup');return response();
}});return {rpc,calls,context:await rpc.verifyOwner({authorization:'Bearer fixture.auth.signature'})};}
test('quote lookup sends exact owner/key/hash to fixed endpoint and returns only bounded frozen quote',async()=>{
 const {rpc,calls,context}=await fixture(()=>Response.json({found:true,quote}));const result=await rpc.lookupQuote(context,input);
 assert.deepEqual(result,quote);assert.ok(Object.isFrozen(result));assert.equal(calls.length,2);
 assert.deepEqual(JSON.parse(calls[1].init.body),{p_owner:'test:supabase:'+customer,p_key_id:null,p_request_key:input.requestKey,p_payload_hash:input.payloadHash,p_capability:'chat',p_model:input.model});
 await assert.rejects(rpc.lookupQuote({...context},input),/gateway_owner_unverified/);assert.equal(calls.length,2);
});
test('missing record returns null; conflicts are safe 409 and do not echo database text',async()=>{
 const absent=await fixture(()=>Response.json({found:false}));assert.equal(await absent.rpc.lookupQuote(absent.context,input),null);
 const conflict=await fixture(()=>Response.json({message:'gateway_idempotency_conflict',details:'not emitted'}, {status:400}));
 await assert.rejects(conflict.rpc.lookupQuote(conflict.context,input),e=>e.code==='gateway_idempotency_conflict'&&e.status===409&&!e.ambiguous);
});
test('lookup rejects result contents, missing fields, wrong model and invalid monetary DTO',async()=>{
 for(const value of [{found:true,quote:{...quote,result:'private'}},{found:true,quote:{...quote,model:'different'}},{found:true,quote:{...quote,reservedCnyMicros:0}},{found:false,quote},{found:true}]){
  const f=await fixture(()=>Response.json(value));await assert.rejects(f.rpc.lookupQuote(f.context,input),/gateway_invalid_response/);
 }
 const f=await fixture(()=>Response.json({found:false}));for(const patch of [{payloadHash:'x'},{requestKey:'short'},{keyId:undefined},{owner:'forged'}])await assert.rejects(f.rpc.lookupQuote(f.context,{...input,...patch}));assert.equal(f.calls.length,1);
});

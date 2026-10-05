import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerKeyRpc} from '../runtime/customer-key-rpc.mjs';
import {createGatewayIngress} from '../runtime/gateway-ingress.mjs';
import {createGatewayRpc,SUPABASE_ORIGIN} from '../runtime/supabase-gateway-rpc.mjs';
const CUSTOMER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',KEY='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY_AUTH='Bearer aw_test_'+'a'.repeat(64),SESSION='Bearer fixture.session.signature';
const usage={currency:'USD',fundedUsdMicros:30000000,spentUsdMicros:400,reservedUsdMicros:600,paymentHoldUsdMicros:0,availableUsdMicros:29999000,completedRequests:1};
function fixture({models=[],revoke=false}={}) {
  const calls=[];
  const base={supabaseOrigin:SUPABASE_ORIGIN,billingMode:'test',secretKey:'sb_secret_syntheticFixtureOnly000000',publishableKey:'sb_publishable_syntheticFixtureOnly000000'};
  const {publishableKey,...keyBase}=base;
  const keys=createCustomerKeyRpc({...keyBase,verifyOwner:async()=>({customerId:CUSTOMER,billingMode:'test'}),fetchImpl:async(url,init)=>{
    calls.push({url,params:JSON.parse(init.body)});
    return Response.json({id:KEY,customer_id:CUSTOMER,billing_mode:'test',scopes:['chat'],daily_limit_usd_micros:null,total_limit_usd_micros:null,expires_at:null,revoked_at:revoke?new Date().toISOString():null});
  }});
  const rpc=createGatewayRpc({...base,keyVerifier:keys,fetchImpl:async(url,init)=>{
    calls.push({url,params:init.body?JSON.parse(init.body):null});
    if(url.endsWith('/auth/v1/user'))return Response.json({id:CUSTOMER,email:'fixture@example.test',email_confirmed_at:new Date().toISOString(),is_anonymous:false});
    if(url.endsWith('account_initialize'))return Response.json({initialized:true,customer_id:CUSTOMER,billing_mode:'test'});
    if(url.endsWith('gateway_usage'))return Response.json(usage);
    throw Error('Unexpected backend request.');
  }});
  const ingress=createGatewayIngress({origin:'https://apiwild.com',enabled:true,rpc,keys,playgroundModels:models,
    service:{execute(){throw Error('Read-only route dispatched.');}},selectQuote(){throw Error('Read-only route reserved.');}});
  return {calls,read:(path,authorization=KEY_AUTH,patch={})=>ingress.handle(new Request('https://apiwild.com'+path,{headers:authorization?{authorization}:{},...patch}))};
}
test('public availability needs no credentials and exposes only configured capabilities',async()=>{
  const f=fixture();const response=await f.read('/api/gateway/config',null);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{inferenceEnabled:false,streaming:true,streamingMode:'buffered-after-settlement',functionCalling:true,nativeStreaming:false,externalTools:false,modes:{chat:false,code:false,research:false},models:[]});assert.equal(f.calls.length,0);
});
test('API model discovery authenticates and limits models to activated chat routes',async()=>{
  const models=[{model:'model-a',capability:'chat',maxOutputTokens:32},{model:'model-a',capability:'code',maxOutputTokens:32},{model:'model-b',capability:'research',maxOutputTokens:32}];
  const f=fixture({models});const response=await f.read('/v1/models');assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{object:'list',data:[{id:'model-a',object:'model',owned_by:'apiwild'}]});assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].params.p_capability,'chat');
  assert.deepEqual(await (await fixture().read('/v1/models')).json(),{object:'list',data:[]});
});
test('API usage reads the owner established by key verification with no account creation or dispatch',async()=>{
  const f=fixture();const response=await f.read('/v1/usage');assert.equal(response.status,200);assert.deepEqual(await response.json(),usage);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].params,{p_owner:'test:supabase:'+CUSTOMER});
  assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('account read uses confirmed session identity and initializes only its own zero-credit ledger',async()=>{
  const f=fixture();const response=await f.read('/api/account',SESSION);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{customerId:CUSTOMER,billingMode:'test',usage});
  assert.deepEqual(f.calls.slice(1).map(c=>c.params),[{p_owner:'test:supabase:'+CUSTOMER},{p_owner:'test:supabase:'+CUSTOMER}]);
});
test('read endpoints reject missing, revoked or wrong credential types and cross-owner query parameters',async()=>{
  for(const path of ['/v1/models','/v1/usage']){
    for(const authorization of [null,SESSION]){const f=fixture();assert.equal((await f.read(path,authorization)).status,401);assert.equal(f.calls.length,0);}
    assert.notEqual((await fixture({revoke:true}).read(path)).status,200);
    assert.equal((await fixture().read(path+'?customerId=someone-else')).status,403);
    assert.equal((await fixture().read(path,KEY_AUTH,{method:'POST'})).status,405);
  }
  assert.equal((await fixture().read('/api/account')).status,401);
});

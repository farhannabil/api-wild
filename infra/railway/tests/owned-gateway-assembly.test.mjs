import test from 'node:test';import assert from 'node:assert/strict';import {createServer,request} from 'node:http';import {createOwnedGatewayFromEnv} from '../runtime/owned-gateway-assembly.mjs';
const customer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env={APIWILD_OWNED_GATEWAY_ENABLED:'true',SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_syntheticFixtureOnly000000',APIWILD_BILLING_MODE:'test'};
test('Supabase-only assembly serves owned keys without upstream credentials or budgets',async()=>{
 const calls=[];const port=createOwnedGatewayFromEnv({env,catalog:{models:[]},fetchImpl:async(url,init)=>{calls.push(url);if(url.endsWith('/auth/v1/user'))return Response.json({id:customer,email:'fixture@example.test',email_confirmed_at:new Date().toISOString(),is_anonymous:false});if(url.endsWith('account_initialize'))return Response.json({initialized:true,customer_id:customer,billing_mode:'test'});if(url.endsWith('key_list'))return Response.json([]);throw Error('Unexpected transport');}});
 const server=createServer((req,res)=>port.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const response=await new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/gateway/keys',headers:{host:'apiwild.com',authorization:'Bearer fixture.session.signature'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end();});assert.equal(response.status,200);assert.deepEqual(response.body,{keys:[]});assert.equal(calls.length,3);assert.ok(calls.every(url=>url.startsWith('https://yautmilnpllojugpmfgy.supabase.co/')));}finally{await new Promise(r=>server.close(r));}
});
test('explicit inference activation requires configured upstream while missing enable flag makes no transport',()=>{assert.equal(createOwnedGatewayFromEnv({env:{},catalog:{models:[]}}),undefined);assert.throws(()=>createOwnedGatewayFromEnv({env:{...env,APIWILD_INFERENCE_ENABLED:'true'},catalog:{models:[]}}),/upstream key/);});

import {readFile} from 'node:fs/promises';
const fullCatalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const route={providerBudgetId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',model:'claude-fable-5',upstreamModel:'claude-fable-5',capability:'chat',maxOutputTokens:1000,maxInputTokens:1000,maxInputChars:1000,supplierReserveCnyMicros:1,supplierSlug:'viapi'};
const activeEnv={...env,APIWILD_INFERENCE_ENABLED:'true',SUBROUTER_API_KEY:'sk-syntheticFixtureOnly000000',APIWILD_RETAIL_RATE_VERSION:'fixture-v1'};
import {conversion} from './supplier-receipt-fixture.mjs';
activeEnv.APIWILD_SUPPLIER_CONVERSION_JSON=JSON.stringify(conversion);
test('activated route must identify its selected catalog supplier',()=>{
 for(const supplierSlug of [undefined,'different-supplier'])assert.throws(()=>createOwnedGatewayFromEnv({env:{...activeEnv,APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([{...route,supplierSlug}])},catalog:fullCatalog}),/supplier/);
});
test('insufficient supplier reservation is rejected before reserve or paid dispatch',async()=>{
 const calls=[];const port=createOwnedGatewayFromEnv({env:{...activeEnv,APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([route])},catalog:fullCatalog,fetchImpl:async(url)=>{calls.push(url);if(url.endsWith('/auth/v1/user'))return Response.json({id:customer,email:'fixture@example.test',email_confirmed_at:new Date().toISOString(),is_anonymous:false});if(url.endsWith('account_initialize'))return Response.json({initialized:true,customer_id:customer,billing_mode:'test'});throw Error('Unexpected transport');}});
 const server=createServer((req,res)=>port.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  const response=await new Promise((resolve,reject)=>{const body=JSON.stringify({model:route.model,messages:[{role:'user',content:'Hello'}],max_tokens:100});const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/gateway',method:'POST',headers:{host:'apiwild.com',authorization:'Bearer fixture.session.signature','content-type':'application/json','content-length':Buffer.byteLength(body),'idempotency-key':'fixture-request-0001'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);});assert.equal(response,503);assert.equal(calls.length,2);assert.ok(calls.every(url=>url.startsWith('https://yautmilnpllojugpmfgy.supabase.co/')));
 }finally{await new Promise(r=>server.close(r));}
});

test('bangai assembly carries the selected private binding through settlement without exposing it',async()=>{
 // Captured correlation fields, reconstructed response/RPC shapes, synthetic credentials.
 const pairs=[['claude-opus-4-6','c2ea8134'],['claude-opus-4-7','b9b162d7'],['gpt-6-astra','afda6e04'],['gpt-6-sol','df8fae53']];
 for(const [model,identity]of pairs){
  const acceptedRoute={...route,model,upstreamModel:model,supplierSlug:'bangai',maxOutputTokens:32,supplierReserveCnyMicros:100000};
  let stored,finished,calls=0;const stamp=new Date().toISOString();
  const port=createOwnedGatewayFromEnv({env:{...activeEnv,APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([acceptedRoute])},catalog:fullCatalog,fetchImpl:async(url,init)=>{
   if(url.endsWith('/auth/v1/user'))return Response.json({id:customer,email:'fixture@example.test',email_confirmed_at:stamp,is_anonymous:false});
   if(url.endsWith('account_initialize'))return Response.json({initialized:true,customer_id:customer,billing_mode:'test'});
   if(url==='https://subrouter.ai/api/status')return Response.json({success:true,data:{quota_per_unit:500000,quota_display_type:'CNY',display_in_currency:true,price:6.8,usd_exchange_rate:6.8}});
   if(url==='https://subrouter.ai/v1/chat/completions'){calls++;return Response.json({id:'synthetic-completion',model,usage:{prompt_tokens:15,completion_tokens:1},choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]},{headers:{'x-request-id':identity}});}
   const p=JSON.parse(init.body);
   if(url.endsWith('apiwild_gateway_reserve')){stored={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',user_id:p.p_owner,key_id:p.p_key_id,provider_budget_id:p.p_provider_budget_id,request_key:p.p_request_key,payload_hash:p.p_payload_hash,capability:p.p_capability,model:p.p_model,rate_version:p.p_rate_version,state:'reserved',version:0,reserved_usd_micros:p.p_reserved_usd_micros,reserved_cny_micros:p.p_reserved_cny_micros,cost_usd_micros:0,cost_cny_micros:0,observed_cny_micros:0,pricing_bound_exceeded:false,settlement_reference:null,result_json:null,usage_json:{},created_at:stamp,updated_at:stamp,expires_at:new Date(Date.now()+3600000).toISOString()};return Response.json({fresh:true,record:stored});}
   if(url.endsWith('apiwild_gateway_claim')){stored={...stored,state:'executing',version:1};return Response.json({claimed:true,record:stored});}
   if(url.endsWith('apiwild_gateway_finish_retail')){finished=p;stored={...stored,state:p.p_state,version:2,cost_usd_micros:p.p_cost_usd_micros,cost_cny_micros:p.p_cost_cny_micros,observed_cny_micros:p.p_cost_cny_micros,settlement_reference:p.p_settlement_reference,result_json:p.p_result,usage_json:p.p_usage};return Response.json({settled:true,replayed:false,record:stored});}
   throw Error('Unexpected fixture transport');
  }});
  const server=createServer((req,res)=>port.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
   const response=await new Promise((resolve,reject)=>{const body=JSON.stringify({model,messages:[{role:'user',content:'Synthetic'}],max_tokens:32});const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/gateway',method:'POST',headers:{host:'apiwild.com',origin:'https://apiwild.com',authorization:'Bearer fixture.session.signature','content-type':'application/json','content-length':Buffer.byteLength(body),'idempotency-key':'fixture-bangai-request-0001'}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,raw,body:JSON.parse(raw)}));});req.on('error',reject);req.end(body);});
   assert.equal(response.status,200);assert.equal(calls,1);assert.equal(finished.p_usage.supplierSlug,'bangai');assert.equal(finished.p_usage.providerRequestId,identity);assert.equal(finished.p_settlement_reference,'usage:'+identity);assert.equal(finished.p_cost_cny_micros,0);assert.equal(finished.p_usage.supplierReconciliationPending,true);
   assert.equal(response.body.result.text,'OK');for(const privateValue of ['bangai',identity,'synthetic-completion','supplierSlug'])assert.equal(response.raw.includes(privateValue),false);
  }finally{await new Promise(r=>server.close(r));}
 }
});

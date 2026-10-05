// Captured identity/usage/log fields; response envelopes and credentials below
// are synthetic shape reconstructions, not retained raw supplier responses.
import test from 'node:test';import assert from 'node:assert/strict';
import {isSupplierRequestIdentity} from '../runtime/supplier-request-identity.mjs';
import {createSubrouterDispatch} from '../runtime/subrouter-dispatch.mjs';
import {createSubrouterReceiptReader} from '../runtime/subrouter-receipt-reader.mjs';
import {createSupplierDebitReconciler} from '../runtime/supplier-debit-reconciliation.mjs';
import {status,conversion,receiptNow} from './supplier-receipt-fixture.mjs';
const captured=[
 {model:'claude-opus-4-6',identity:'c2ea8134',logId:797,quota:1,prompt:15,completion:1,receiptId:'20261005103416701666095qQq9b4bQ'},
 {model:'claude-opus-4-7',identity:'b9b162d7',logId:809,quota:2,prompt:26,completion:2,receiptId:'20261005103418347737472VuFzmaZc'},
 {model:'gpt-6-astra',identity:'afda6e04',logId:948,quota:39,prompt:310,completion:5,receiptId:'20261005103448157764465yEovN3p4'},
 {model:'gpt-6-sol',identity:'df8fae53',logId:981,quota:15,prompt:310,completion:5,receiptId:'20261005103452585839715v2oxKG2C'},
];
const budget='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner='test:supabase:'+requestId,token='sk-syntheticFixtureNotARealKey000000',accessToken='syntheticAccountAccessTokenOnly000000';
function log(c,patch={}){return {id:c.logId,created_at:Math.floor(receiptNow/1000),user_id:21872,token_id:113358,model_name:c.model,type:2,quota:c.quota,request_id:c.receiptId,upstream_request_id:c.identity,other:JSON.stringify({provider_slug:'bangai',billing_source:'wallet',billing_multiplier:1}),...patch};}
function reader(c,{rows=[log(c)],provider='bangai'}={}){let calls=0;const adapter=createSubrouterReceiptReader({enabled:true,accessToken,accountUserId:21872,bindings:{[budget]:{tokenId:113358,modelProviders:{[c.model]:provider}}},conversion,clock:()=>receiptNow,fetchImpl:async(url,init)=>{calls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'error');return Response.json({success:true,data:url.endsWith('/api/status')?status:{items:rows,has_more:false,next_cursor:'',page_size:20}});}});return {adapter,get calls(){return calls;}};}
const query=c=>({keyReference:budget,upstreamResponseId:c.identity,model:c.model});
test('UUID default is preserved; short IDs require one of the four explicit bangai model pairs',()=>{
 assert.equal(isSupplierRequestIdentity(requestId),true);
 for(const c of captured){assert.equal(isSupplierRequestIdentity(c.identity,{supplierSlug:'bangai',model:c.model}),true);assert.equal(isSupplierRequestIdentity(c.identity,{supplierSlug:'other',model:c.model}),false);assert.equal(isSupplierRequestIdentity(c.identity,{model:c.model}),false);}
 for(const identity of ['C2EA8134','c2ea813','c2ea81345','c2ea8134\n','c2ea8134\t',' c2ea8134','x'.repeat(201),'chatcmpl-c2ea8134','c2ea813\0'])assert.equal(isSupplierRequestIdentity(identity,{supplierSlug:'bangai',model:captured[0].model}),false);
 assert.equal(isSupplierRequestIdentity('c2ea8134',{supplierSlug:'bangai',model:'unapproved-model'}),false);
});
test('four captured bangai correlations survive transport and exact final wallet reconciliation',async()=>{
 for(const c of captured){
  let dispatches=0;const dispatch=createSubrouterDispatch({routes:[{providerBudgetId:budget,model:c.model,upstreamModel:c.model,rateVersion:'fixture',apiKey:token,capability:'chat',maxOutputTokens:32,maxInputChars:1024,supplierSlug:'bangai'}],fetchImpl:async()=>{dispatches++;return Response.json({id:'synthetic-completion',model:c.model,usage:{prompt_tokens:c.prompt,completion_tokens:c.completion},choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]},{headers:{'x-request-id':c.identity}});}});
  const response=await dispatch({record:{provider_budget_id:budget,model:c.model,rate_version:'fixture',capability:'chat',state:'executing'},payload:{format:'openai',body:{model:c.model,messages:[{role:'user',content:'Synthetic shape'}],max_tokens:32}},signal:new AbortController().signal});assert.equal(response.providerRequestId,c.identity);assert.equal(dispatches,1);
  const f=reader(c),receipt=await f.adapter.readReceipt(query(c));assert.equal(receipt.nativeDebit.provider_slug,'bangai');assert.equal(receipt.receiptId,c.receiptId);
  const facts=[];const reconciler=createSupplierDebitReconciler({enabled:true,readRequest:async()=>({owner,requestId,...query(c),supplierPending:true}),readReceipt:f.adapter.readReceipt,rpc:async(name,p)=>{facts.push(p);return {reconciled:true};}});
  assert.equal((await reconciler.reconcile({owner,requestId})).reconciled,true);assert.equal((await reconciler.reconcile({owner,requestId})).reconciled,true);assert.deepEqual(facts[0],facts[1]);assert.equal(facts[0].p_fact.upstream_response_id,c.identity);
 }
});
test('short receipt identities reject wrong providers, duplicates, unknown IDs and all binding/source mismatches',async()=>{
 const c=captured[0],base=log(c);
 for(const options of [{provider:'other'},{rows:[]},{rows:[base,base]},...[
  {upstream_request_id:'deadbeef'},{token_id:1},{user_id:1},{model_name:'other'},{type:5},
  {other:JSON.stringify({provider_slug:'other',billing_source:'wallet',billing_multiplier:1})},
  {other:JSON.stringify({provider_slug:'bangai',billing_source:'subscription',billing_multiplier:1})},
  {other:JSON.stringify({provider_slug:'bangai',billing_source:'wallet',billing_multiplier:2})},
 ].map(patch=>({rows:[{...base,...patch}]}))])await assert.rejects(reader(c,options).adapter.readReceipt(query(c)));
 const wrong=reader(c,{provider:'other'});await assert.rejects(wrong.adapter.readReceipt(query(c)));assert.equal(wrong.calls,0);
 const held=createSupplierDebitReconciler({enabled:true,readRequest:async()=>({owner,requestId,...query(c),supplierPending:true}),readReceipt:reader(c,{rows:[base,base]}).adapter.readReceipt,rpc:()=>assert.fail('Unverified debit must not write')});assert.deepEqual(await held.reconcile({owner,requestId}),{reconciled:false,held:true,automaticRetry:false});
});
test('transport rejects short IDs for other suppliers and unapproved bangai models without retry',async()=>{
 for(const [supplierSlug,model]of [['other',captured[0].model],['bangai','other-model'],[undefined,captured[0].model]]){
  let calls=0;const dispatch=createSubrouterDispatch({routes:[{providerBudgetId:budget,model,upstreamModel:model,rateVersion:'fixture',apiKey:token,capability:'chat',maxOutputTokens:32,maxInputChars:1024,supplierSlug}],fetchImpl:async()=>{calls++;return Response.json({id:'synthetic',model,usage:{prompt_tokens:1,completion_tokens:1},choices:[{message:{role:'assistant',content:'OK'}}]},{headers:{'x-request-id':'c2ea8134'}});}});
  await assert.rejects(dispatch({record:{provider_budget_id:budget,model,rate_version:'fixture',capability:'chat',state:'executing'},payload:{format:'openai',body:{model,messages:[{role:'user',content:'Synthetic'}],max_tokens:32}},signal:new AbortController().signal}),e=>e.ambiguous);assert.equal(calls,1);
 }
});

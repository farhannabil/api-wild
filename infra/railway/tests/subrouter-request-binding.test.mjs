import test from 'node:test';import assert from 'node:assert/strict';
import {createSubrouterDispatch} from '../runtime/subrouter-dispatch.mjs';
const budget='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const route={providerBudgetId:budget,model:'fixture-model',upstreamModel:'fixture-upstream',rateVersion:'fixture-v1',apiKey:'sk-syntheticFixtureOnly0000',capability:'chat',maxOutputTokens:64,maxInputChars:1024};
const record={provider_budget_id:budget,model:route.model,rate_version:route.rateVersion,capability:'chat',state:'executing'};
const payload={format:'openai',body:{model:route.model,messages:[{role:'user',content:'fixture'}],max_tokens:16}};
const response={id:'synthetic-completion-id',model:route.upstreamModel,choices:[{message:{role:'assistant',content:'fixture'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:4}};
async function run(header,body=response){let calls=0;const dispatch=createSubrouterDispatch({routes:[route],fetchImpl:async()=>{calls++;return Response.json(body,{headers:header===null?{}:{'x-request-id':header}});}});
 try{return {result:await dispatch({record,payload,signal:new AbortController().signal}),calls};}catch(error){assert.equal(calls,1);throw error;}}
test('wallet request ID comes from the exact response while completion identity remains intact',async()=>{
 const {result,calls}=await run(requestId);assert.equal(calls,1);assert.equal(result.providerRequestId,requestId);assert.equal(result.providerResponseId,response.id);assert.equal(result.settlementVerified,false);
});
test('missing wallet header preserves legacy completion binding without inventing a request ID',async()=>{
 const {result}=await run(null);assert.equal(result.providerResponseId,response.id);assert.equal(Object.hasOwn(result,'providerRequestId'),false);
});
test('malformed or multiple request IDs remain ambiguous and cannot bypass completion validation',async()=>{
 for(const header of ['not-a-uuid',requestId+', '+requestId,'sk-private-looking-fixture'])await assert.rejects(run(header),e=>e.ambiguous===true&&e.code==='subrouter_dispatch_requires_reconciliation');
 for(const patch of [{id:''},{model:'different'},{usage:{}}])await assert.rejects(run(requestId,{...response,...patch}),e=>e.ambiguous===true);
});

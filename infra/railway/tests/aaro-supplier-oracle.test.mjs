import test from 'node:test';import assert from 'node:assert/strict';
import {createAaroSupplierOracle} from '../runtime/aaro-supplier-oracle.mjs';
import {status,conversion,receiptNow} from './supplier-receipt-fixture.mjs';
const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',supplierId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const owner='test:supabase:'+id,model='MiniMax-M2.7-highspeed',accessToken='syntheticAaroManagementTokenOnly00000';
const binding={protocol:'aaro-subrouter-usage-v1',product:'aaro',owner,mode:'test',keyReference:key,tariffVersion:'fixture-NOT-A-PRICE',acceptanceReceiptSHA256:'a'.repeat(64),model,requestKey:'synthetic_request_key_001',payloadHash:'b'.repeat(64),maximumInputTokens:100,maximumOutputTokens:32,totalCapNativeCnyMicros:50000000};
const record={id,owner,key_reference:key,billing_mode:'test',state:'executing',binding};
const native={id:573,created_at:Math.floor(receiptNow/1000),user_id:21872,token_id:123,model_name:model,type:2,quota:4,request_id:'synthetic_receipt',upstream_request_id:supplierId,prompt_tokens:8,completion_tokens:4,other:JSON.stringify({billing_source:'wallet',billing_multiplier:1,provider_slug:'leapnode'})};
function fixture({rows=[native],config={},drift=false}={}){
 const calls=[];let statuses=0;
 const oracle=createAaroSupplierOracle({enabled:true,product:'aaro',mode:'test',keyReference:key,tokenId:123,modelProviders:{[model]:'leapnode'},tariffVersion:binding.tariffVersion,acceptanceReceiptSHA256:binding.acceptanceReceiptSHA256,totalCapNativeCnyMicros:50000000,accessToken,accountUserId:21872,conversion,clock:()=>receiptNow,...config,fetchImpl:async(url,init)=>{
  calls.push({url,method:init.method,redirect:init.redirect});assert.equal(init.method,'GET');assert.equal(new URL(url).origin,'https://subrouter.ai');
  if(url.endsWith('/api/status'))return Response.json({success:true,data:{...status,...(drift&&++statuses>1?{price:6.9,usd_exchange_rate:6.9}:{})}});
  assert.equal(init.headers.Authorization,'Bearer '+accessToken);return Response.json({success:true,data:{items:rows,has_more:false,next_cursor:'',page_size:20}});
 }});return {oracle,calls};
}
const invoke=(f,patch={})=>f.oracle.reconcileSupplierDebit({record,providerRequestId:supplierId,inputTokens:8,outputTokens:4,...patch});
test('disabled oracle does not inspect secrets or contact a provider',async()=>{
 const oracle=createAaroSupplierOracle({enabled:false,fetchImpl:()=>assert.fail('No network')});await assert.rejects(oracle.reconcileSupplierDebit({}));
});
test('independent key/model/header/log counts and exact CNY charge bind one AARO reservation',async()=>{
 const f=fixture(),first=await invoke(f),again=await invoke(f);assert.deepEqual(first,again);
 assert.deepEqual(Object.keys(first),['product','owner','reservationId','mode','keyReference','model','providerRequestId','inputTokens','outputTokens','actualNativeCnyMicros','supplierDebitReference','reconciliationReceiptSHA256']);
 assert.equal(first.product,'aaro');assert.equal(first.owner,owner);assert.equal(first.reservationId,id);assert.equal(first.actualNativeCnyMicros,55);
 assert.equal(first.inputTokens,8);assert.equal(first.outputTokens,4);assert.match(first.reconciliationReceiptSHA256,/^[a-f0-9]{64}$/);
 assert.equal(f.calls.length,6);assert.ok(!JSON.stringify(first).includes(accessToken));
});
test('completion token claims cannot replace or coerce independently logged usage',async()=>{
 const f=fixture({rows:[{...native,prompt_tokens:9,completion_tokens:5}]});const proof=await invoke(f);
 assert.equal(proof.inputTokens,9);assert.equal(proof.outputTokens,5);
 const base=await invoke(fixture());assert.notEqual(proof.reconciliationReceiptSHA256,base.reconciliationReceiptSHA256);
 for(const patch of [{prompt_tokens:undefined},{completion_tokens:undefined},{prompt_tokens:'8'},{prompt_tokens:0},{completion_tokens:-1},{completion_tokens:0.1}])await assert.rejects(invoke(fixture({rows:[{...native,...patch}]})));
});
test('foreign product, key, owner, mode, tariff or acceptance cannot read the supplier log',async()=>{
 for(const patch of [{product:'apiwild'},{keyReference:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},{owner:'test:supabase:'+key},{mode:'live'},{tariffVersion:'foreign'},{acceptanceReceiptSHA256:'d'.repeat(64)},{model:'foreign-model'}]){
  const f=fixture();await assert.rejects(invoke(f,{record:{...record,binding:{...binding,...patch}}}));assert.equal(f.calls.length,0);
 }
});
test('missing, duplicate, wrong-key and nonwallet native receipts never settle',async()=>{
 for(const rows of [[],[native,native],[{...native,token_id:999}],[{...native,upstream_request_id:id}],[{...native,other:JSON.stringify({billing_source:'subscription',billing_multiplier:1,provider_slug:'leapnode'})}]])await assert.rejects(invoke(fixture({rows})));
});
test('cancelled work, unclaimed reservations and conversion drift preserve the hold',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(invoke(f,{signal:controller.signal}));assert.equal(f.calls.length,0);
 await assert.rejects(invoke(f,{record:{...record,state:'reserved'}}));assert.equal(f.calls.length,0);
 await assert.rejects(invoke(fixture({drift:true})));
});
test('configuration rejects another product, invalid mode, multiple-product budget or more than six routes',()=>{
 for(const config of [{product:'apiwild'},{mode:'other'},{totalCapNativeCnyMicros:100000000},{keyReference:'not-a-key-identity'},{modelProviders:{}},{modelProviders:Object.fromEntries(Array.from({length:7},(_,i)=>['model-'+i,'leapnode']))}])assert.throws(()=>fixture({config}));
});

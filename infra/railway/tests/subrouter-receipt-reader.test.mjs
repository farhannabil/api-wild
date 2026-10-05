import test from 'node:test';import assert from 'node:assert/strict';
import {createSubrouterReceiptReader} from '../runtime/subrouter-receipt-reader.mjs';
import {normalizedQuotaCnyMicros,createSupplierConversionGuard,validateSupplierConversion} from '../runtime/subrouter-supplier-conversion.mjs';
import {createSupplierDebitReconciler} from '../runtime/supplier-debit-reconciliation.mjs';
import {runSupplierDebitOperator,createSupplierDebitRpc} from '../runtime/supplier-debit-operator.mjs';
import {status,conversion,receiptNow} from './supplier-receipt-fixture.mjs';
const keyReference='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',upstreamResponseId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const owner='test:supabase:'+requestId,query={keyReference,upstreamResponseId,model:'MiniMax-M2.7-highspeed'};
const bindings={[keyReference]:{tokenId:123,modelProviders:{[query.model]:'leapnode'}}};
const token='syntheticAccountAccessTokenOnly000000';
const row={id:573,created_at:Math.floor(receiptNow/1000),user_id:21872,token_id:123,model_name:query.model,type:2,quota:4,request_id:'synthetic_receipt',upstream_request_id:upstreamResponseId,other:JSON.stringify({billing_source:'wallet',billing_multiplier:1,provider_slug:'leapnode'})};
function fixture({rows=[row],statusPatch={},afterPatch={},page,fetchPatch}={}){const calls=[];let statuses=0;return {calls,reader:createSubrouterReceiptReader({enabled:true,accessToken:token,accountUserId:21872,bindings,conversion,clock:()=>receiptNow,fetchImpl:async(url,init)=>{
 calls.push({url,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'error');if(fetchPatch)return fetchPatch(url,init);
 if(url.endsWith('/api/status')){assert.equal(init.headers.Authorization,undefined);return Response.json({success:true,data:{...status,...statusPatch,...(++statuses>1?afterPatch:{})}});}
 assert.equal(init.headers.Authorization,'Bearer '+token);assert.equal(init.headers['New-Api-User'],'21872');
 return Response.json({success:true,data:page??{items:rows,has_more:false,next_cursor:'',page_size:20}});
 }})};}
test('actual USD quota uses exact conservative normalization and stable native audit',async()=>{
 const f=fixture();const first=await f.reader.readReceipt(query),second=await f.reader.readReceipt(query);assert.deepEqual(first,second);
 assert.equal(first.costCnyMicros,55);assert.equal(first.nativeDebit.quota,4);assert.equal(first.nativeDebit.quota_unit_currency,'USD');assert.equal(first.nativeDebit.settings_sha256,conversion.settingsSha256);assert.equal(f.calls.length,6);
 assert.equal(normalizedQuotaCnyMicros(0,conversion),0);assert.equal(normalizedQuotaCnyMicros(500000,conversion),6800000);
 assert.throws(()=>normalizedQuotaCnyMicros(Number.MAX_SAFE_INTEGER,conversion));assert.throws(()=>validateSupplierConversion({...conversion,settingsSha256:'a'.repeat(64)}));
});
test('every receipt identity and wallet-source mismatch fails closed',async()=>{
 for(const patch of [{token_id:999},{user_id:999},{model_name:'other'},{type:1},{quota:-1},{quota:0.5},{request_id:'bad receipt'},
  {other:JSON.stringify({billing_source:'subscription',billing_multiplier:1,provider_slug:'leapnode'})},
  {other:JSON.stringify({billing_source:'wallet',billing_multiplier:2,provider_slug:'leapnode'})},
  {other:JSON.stringify({billing_source:'wallet',billing_multiplier:1,provider_slug:'wrong'})},{created_at:1}])await assert.rejects(fixture({rows:[{...row,...patch}]}).reader.readReceipt(query));
 await assert.rejects(fixture({rows:[]}).reader.readReceipt(query));await assert.rejects(fixture({rows:[row,row]}).reader.readReceipt(query));
});
test('published conversion drift before or after logs prevents reconciliation',async()=>{
 const early=fixture({statusPatch:{usd_exchange_rate:6.9}});await assert.rejects(early.reader.readReceipt(query));assert.equal(early.calls.length,1);
 const late=fixture({afterPatch:{price:6.9,usd_exchange_rate:6.9}});await assert.rejects(late.reader.readReceipt(query));assert.equal(late.calls.length,3);
});
test('pagination, response-size, schema and redirect bounds cannot be bypassed',async()=>{
 for(const options of [{page:{items:[row],has_more:true,next_cursor:'first',page_size:20}},
  {page:{items:[row],has_more:false,next_cursor:'',page_size:21}},
  {fetchPatch:async()=>new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}})},
  {fetchPatch:async()=>Response.json({success:false,data:status})},
  {fetchPatch:async()=>new Response('',{status:302,headers:{location:'https://evil.invalid'}})}])await assert.rejects(fixture(options).reader.readReceipt(query));
});
test('expired, future or aborted conversion guard performs no paid work',async()=>{
 for(const now of [Date.parse(conversion.observedAt)-1,Date.parse(conversion.validUntil),NaN]){let calls=0;const guard=createSupplierConversionGuard({conversion,clock:()=>now,fetchImpl:async()=>{calls++;throw Error();}});await assert.rejects(guard.assertConversion());assert.equal(calls,0);}
 const f=fixture();const controller=new AbortController();controller.abort();await assert.rejects(f.reader.readReceipt(query,{signal:controller.signal}));assert.equal(f.calls.length,0);
});
test('reconciler preserves native audit and stable fact digest; tampered normalized cost never applies',async()=>{
 const receipt=await fixture().reader.readReceipt(query),writes=[];
 const reconciler=createSupplierDebitReconciler({enabled:true,readRequest:async()=>({owner,requestId,...query,supplierPending:true}),readReceipt:async q=>{assert.deepEqual(q,query);return receipt;},rpc:async(name,p)=>{writes.push({name,p});return {reconciled:true};}});
 assert.equal((await reconciler.reconcile({owner,requestId})).reconciled,true);await reconciler.reconcile({owner,requestId});assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].p.p_fact.native_debit.quota,4);
 const bad=createSupplierDebitReconciler({enabled:true,readRequest:async()=>({owner,requestId,...query,supplierPending:true}),readReceipt:async()=>({...receipt,costCnyMicros:54}),rpc:()=>assert.fail('Must not apply')});assert.equal((await bad.reconcile({owner,requestId})).held,true);
});
test('disabled or check operator never networks; exact fixed RPC rejects extra authority',async()=>{
 const env={SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',SUBROUTER_ACCOUNT_ACCESS_TOKEN:token,SUBROUTER_ACCOUNT_USER_ID:'21872',APIWILD_SUPPLIER_BINDINGS_JSON:JSON.stringify(bindings),APIWILD_SUPPLIER_CONVERSION_JSON:JSON.stringify(conversion)},output=[];
 for(const mode of ['--check','--execute'])await runSupplierDebitOperator({argv:[mode,'--owner',owner,'--request',requestId],env,fetchImpl:()=>assert.fail('no network'),write:x=>output.push(x)});
 assert.equal(output[0].configured,true);assert.equal(output[1].status,'disabled');assert.ok(!JSON.stringify(output).includes(token));
 const rpc=createSupplierDebitRpc({secretKey:env.SUPABASE_SECRET_KEY,fetchImpl:()=>assert.fail('no transport')});
 await assert.rejects(rpc('arbitrary',{p_owner:owner,p_request:requestId}));await assert.rejects(rpc('apiwild_supplier_request_read',{p_owner:owner,p_request:requestId,sql:'forbidden'}));
});

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
function fixture({rows=[row],statusPatch={},afterPatch={},page,pages,fetchPatch,timeoutMs}={}){const calls=[];let statuses=0,logPages=0;return {calls,reader:createSubrouterReceiptReader({enabled:true,accessToken:token,accountUserId:21872,bindings,conversion,clock:()=>receiptNow,...(timeoutMs?{timeoutMs}:{}),fetchImpl:async(url,init)=>{
 calls.push({url,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'error');if(fetchPatch)return fetchPatch(url,init);
 if(url.endsWith('/api/status')){assert.equal(init.headers.Authorization,undefined);return Response.json({success:true,data:{...status,...statusPatch,...(++statuses>1?afterPatch:{})}});}
 assert.equal(init.headers.Authorization,'Bearer '+token);assert.equal(init.headers['New-Api-User'],'21872');
 if(pages){assert.equal(new URL(url).searchParams.get('cursor'),logPages===0?'first':'page-'+logPages);assert.equal(new URL(url).searchParams.get('page_size'),'20');}
 return Response.json({success:true,data:pages?pages[logPages++]:page??{items:rows,has_more:false,next_cursor:'',page_size:20}});
 }})};}
function logPages(count,{matchPage=0,duplicatePage,lastHasMore=false}={}){
 return Array.from({length:count},(_,index)=>({items:Array.from({length:20},(_,slot)=>slot===0&&(index===matchPage||index===duplicatePage)?{...row}:{upstream_request_id:'unrelated-'+index+'-'+slot}),
  has_more:index<count-1||lastHasMore,next_cursor:index<count-1||lastHasMore?'page-'+(index+1):'',page_size:20}));
}
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

test('complete later-page scans find receipts beyond 200 rows and reject late duplicates',async()=>{
 const later=fixture({pages:logPages(11,{matchPage:10})});assert.equal((await later.reader.readReceipt(query)).receiptId,row.request_id);assert.equal(later.calls.length,13);
 const duplicate=fixture({pages:logPages(11,{matchPage:0,duplicatePage:10})});await assert.rejects(duplicate.reader.readReceipt(query));assert.equal(duplicate.calls.length,12);
});

test('exact 1000-row terminal scan succeeds; a continuing 50th page never returns an early match',async()=>{
 const complete=fixture({pages:logPages(50,{matchPage:49})});assert.equal((await complete.reader.readReceipt(query)).nativeDebit.log_id,row.id);assert.equal(complete.calls.length,52);
 const incomplete=fixture({pages:logPages(50,{matchPage:0,lastHasMore:true})});await assert.rejects(incomplete.reader.readReceipt(query));assert.equal(incomplete.calls.length,51);
 assert.equal(incomplete.calls.filter(call=>call.url.includes('/api/log/self?')).length,50);
});

test('late cursor loops and malformed pages keep a previously found receipt unverified',async()=>{
 for(const patch of [{next_cursor:'page-5'}, {next_cursor:'bad cursor'}, {items:Array(21).fill({upstream_request_id:'unrelated'})}, {page_size:21}, {has_more:'true'}]){
  const pages=logPages(12);Object.assign(pages[10],patch);const f=fixture({pages});await assert.rejects(f.reader.readReceipt(query));
  assert.equal(f.calls.filter(call=>call.url.includes('/api/log/self?')).length,11);
 }
});

test('later-page source errors and oversized bodies cannot yield a previously found receipt',async()=>{
 for(const badResponse of [()=>new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}}),()=>Response.json({success:true,data:{items:[]}}, {headers:{'content-length':'262145'}}),()=>new Response('',{status:302,headers:{location:'https://other.invalid'}})]){
  const pages=logPages(11);let page=0;const f=fixture({fetchPatch:async url=>url.endsWith('/api/status')?Response.json({success:true,data:status}):++page===11?badResponse():Response.json({success:true,data:pages[page-1]})});
  await assert.rejects(f.reader.readReceipt(query));assert.equal(page,11);assert.equal(f.calls.length,12);
 }
});

test('conversion is verified again after a complete 1000-row scan',async()=>{
 const f=fixture({pages:logPages(50),afterPatch:{usd_exchange_rate:6.9}});await assert.rejects(f.reader.readReceipt(query));assert.equal(f.calls.length,52);
});

test('late-page caller cancellation stops scanning without accepting an earlier match',async()=>{
 const pages=logPages(12),controller=new AbortController();let page=0;
 const f=fixture({fetchPatch:async url=>{if(url.endsWith('/api/status'))return Response.json({success:true,data:status});page++;if(page===11)controller.abort();return Response.json({success:true,data:pages[page-1]});}});
 await assert.rejects(f.reader.readReceipt(query,{signal:controller.signal}));assert.equal(page,11);assert.equal(f.calls.length,12);
});

test('the default 20-second deadline still bounds a stalled later page',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const pages=logPages(12);let page=0,lateSignal,notify;const waiting=new Promise(resolve=>{notify=resolve;});
 const f=fixture({fetchPatch:async(url,init)=>{if(url.endsWith('/api/status'))return Response.json({success:true,data:status});page++;if(page===11){lateSignal=init.signal;notify();return new Promise(()=>{});}return Response.json({success:true,data:pages[page-1]});}});
 const pending=f.reader.readReceipt(query),rejected=assert.rejects(pending);await waiting;
 assert.equal(lateSignal.aborted,false);t.mock.timers.tick(19999);assert.equal(lateSignal.aborted,false);
 t.mock.timers.tick(1);await rejected;assert.equal(lateSignal.aborted,true);assert.equal(page,11);assert.equal(f.calls.length,12);
});

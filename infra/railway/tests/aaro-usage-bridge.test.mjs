// Isolated wire/security fixtures; synthetic units/prices/proofs, no supplier or live RPC call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAaroUsageBridge,createAaroUsageRpc,validateAaroBinding,AARO_PROTOCOL,AARO_BILLING_ORIGIN,AARO_SUPABASE_ORIGIN} from '../runtime/aaro-usage-bridge.mjs';
const USER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const owner='test:supabase:'+USER,bridgeKey='k'.repeat(32),sha='a'.repeat(64);
const binding=(changes={})=>({protocol:AARO_PROTOCOL,product:'aaro',owner,mode:'test',keyReference:'fixture-key',tariffVersion:'fixture-NOT-A-PRICE',acceptanceReceiptSHA256:sha,model:'fixture/model',requestKey:randomUUID(),payloadHash:'b'.repeat(64),maximumInputTokens:100,maximumOutputTokens:20,totalCapNativeCnyMicros:50000000,...changes});
const wire=(action,reservation,changes={})=>{const {totalCapNativeCnyMicros,...bound}=reservation;const body={action,...bound,...changes};delete body.nativeCurrency;delete body.maximumCredits;delete body.maximumNativeCnyMicros;delete body.reserved;delete body.fresh;delete body.claimed;delete body.providerAdmissionReceiptSHA256;delete body.state;return body;};
const request=(body,{headers={},url=AARO_BILLING_ORIGIN+'/api/aaro/usage',method='POST',signal,raw}={})=>new Request(url,{method,headers:{origin:AARO_BILLING_ORIGIN,'content-type':'application/json','x-aaro-bridge':bridgeKey,authorization:'Bearer fixture-customer-token',...headers},...(method==='POST'?{body:raw??JSON.stringify(body)}:{}),signal});
async function response(handler,body,options){const reply=await handler(request(body,options));return {status:reply.status,body:await reply.json(),headers:reply.headers};}
function fixture(overrides={}){
  const counters={verify:0,reserve:0,read:0,claim:0,settle:0,uncertain:0,oracle:0},records=new Map(),settlementFacts=[];
  const clone=value=>structuredClone(value);
  const rpc={
    async verifyCustomer(){counters.verify++;return {id:USER};},
    async reserve(who,b){counters.reserve++;const existing=[...records.values()].find(r=>r.request_key===b.requestKey&&r.owner===who);if(existing)return {fresh:false,record:clone(existing)};
      const r={id:randomUUID(),owner:who,binding:clone(b),key_reference:b.keyReference,billing_mode:b.mode,request_key:b.requestKey,state:'reserved',maximum_credits:180,maximum_native_cny_micros:120,actual_credits:0,actual_native_cny_micros:0,observed_native_cny_micros:0,admission_receipt_sha256:'c'.repeat(64),expires_at:new Date(Date.now()+120000).toISOString()};records.set(r.id,r);return {fresh:true,record:clone(r)};},
    async read(who,id){counters.read++;const r=records.get(id);if(!r||r.owner!==who)throw Error('fixture ledger lookup denied');return {record:clone(r)};},
    async claim(who,id){counters.claim++;const r=records.get(id),claimed=r.state==='reserved';if(claimed)r.state='executing';return {claimed,record:clone(r)};},
    async settle(who,id,b,f){counters.settle++;settlementFacts.push(clone(f));const r=records.get(id);
      if(f.observedOnly||f.inputTokens>b.maximumInputTokens||f.outputTokens>b.maximumOutputTokens||f.actualNativeCnyMicros>r.maximum_native_cny_micros){r.state='uncertain';r.observed_native_cny_micros=f.actualNativeCnyMicros;return {settled:false,record:clone(r)};}
      Object.assign(r,{state:'succeeded',actual_credits:f.inputTokens+4*f.outputTokens,actual_native_cny_micros:f.actualNativeCnyMicros,observed_native_cny_micros:f.actualNativeCnyMicros,input_tokens:f.inputTokens,output_tokens:f.outputTokens,provider_request_id:f.providerRequestId,supplier_debit_reference:f.supplierDebitReference,reconciliation_receipt_sha256:f.reconciliationReceiptSHA256});return {settled:true,replayed:false,record:clone(r)};},
    async uncertain(who,id){counters.uncertain++;const r=records.get(id);if(r.state==='executing')r.state='uncertain';return {held:['reserved','executing','uncertain'].includes(r.state),record:clone(r)};},
  };
  const oracle=async({record,providerRequestId,inputTokens,outputTokens})=>{counters.oracle++;return {product:'aaro',owner:record.owner,reservationId:record.id,mode:record.billing_mode,keyReference:record.key_reference,model:record.binding.model,providerRequestId,inputTokens,outputTokens,actualNativeCnyMicros:12,supplierDebitReference:'debit-'+record.id,reconciliationReceiptSHA256:'d'.repeat(64)};};
  const config={enabled:true,financialAcceptanceVerified:true,providerAcceptanceVerified:true,webhookIngressVerified:true,billingMode:'test',keyReference:'fixture-key',tariffVersion:'fixture-NOT-A-PRICE',acceptanceReceiptSHA256:sha,bridgeKey,rpc,reconcileSupplierDebit:oracle,...overrides};
  return {handler:createAaroUsageBridge(config),config,rpc,oracle,counters,records,settlementFacts};
}
const reservation=async f=>{const result=await response(f.handler,{action:'reserve',...binding()});assert.equal(result.status,200);return result.body;};
const executing=async f=>{const r=await reservation(f);const result=await response(f.handler,wire('claim',r));assert.equal(result.status,200);assert.equal(result.body.claimed,true);return r;};
const settleBody=r=>wire('settle',r,{providerRequestId:'provider-'+r.id,inputTokens:10,outputTokens:2});

test('factory remains disabled with any missing acceptance or mandatory independent supplier oracle',async()=>{
  for(const patch of [{enabled:false},{financialAcceptanceVerified:false},{providerAcceptanceVerified:false},{webhookIngressVerified:false},{reconcileSupplierDebit:undefined},{rpc:{}}]){
    const f=fixture(patch),result=await response(f.handler,{action:'reserve',...binding()});assert.equal(result.status,503);assert.equal(result.body.code,'AARO_FINANCE_UNACCEPTED');assert.equal(f.counters.verify,0);assert.equal(f.counters.oracle,0);
  }
});
test('exact origin/path/method/JSON and ASCII private bridge header are enforced before ledger work',async()=>{
  const f=fixture(),body={action:'reserve',...binding()};
  for(const options of [{headers:{origin:'https://attacker.invalid'}},{url:'https://attacker.invalid/api/aaro/usage'},{url:AARO_BILLING_ORIGIN+'/api/aaro/usage?x=1'},{headers:{'x-aaro-bridge':'x'.repeat(32)}},{headers:{'x-aaro-bridge':'é'.repeat(32)}}])assert.equal((await response(f.handler,body,options)).status,403);
  assert.equal((await response(f.handler,body,{method:'GET'})).status,405);assert.equal((await response(f.handler,body,{headers:{'content-type':'text/plain'}})).status,415);
  assert.deepEqual(f.counters,{verify:0,reserve:0,read:0,claim:0,settle:0,uncertain:0,oracle:0});
});
test('oversized/malformed requests and caller-supplied balances, prices or debits are rejected',async()=>{
  const f=fixture(),body={action:'reserve',...binding()};assert.equal((await response(f.handler,body,{raw:'x'.repeat(4097)})).status,413);assert.equal((await response(f.handler,body,{raw:'{'})).status,400);
  for(const patch of [{maximumCredits:1},{actualNativeCnyMicros:0},{creditBalance:99999},{totalCapNativeCnyMicros:100000000},{maximumInputTokens:0}])assert.notEqual((await response(f.handler,{...body,...patch})).status,200);
  assert.equal(f.counters.reserve,0);assert.equal(f.counters.oracle,0);
});
test('customer identity comes from confirmed Supabase lookup and immutable configured policy',async()=>{
  const f=fixture();assert.equal((await response(f.handler,{action:'reserve',...binding({owner:'test:supabase:'+OTHER})})).status,403);
  for(const patch of [{mode:'live',owner:'live:supabase:'+USER},{keyReference:'retired-key'},{tariffVersion:'other-policy'},{acceptanceReceiptSHA256:'f'.repeat(64)}])assert.equal((await response(f.handler,{action:'reserve',...binding(patch)})).status,409);
  assert.equal((await response(f.handler,{action:'reserve',...binding()},{headers:{authorization:''}})).status,401);assert.equal(f.counters.reserve,0);
});
test('reserve/claim/settle versioned DTO yields one receipt and no supplier call until independent settlement',async()=>{
  const f=fixture(),r=await executing(f);assert.equal(r.protocol,AARO_PROTOCOL);assert.equal(r.product,'aaro');assert.equal(r.nativeCurrency,'CNY');assert.equal(r.maximumCredits,180);assert.equal(r.maximumNativeCnyMicros,120);assert.equal(r.totalCapNativeCnyMicros,50000000);
  assert.deepEqual(Object.keys(r.receipt).sort(),['expires','id','owner','signature']);assert.equal(f.counters.oracle,0);
  const result=await response(f.handler,settleBody(r));assert.equal(result.status,200);assert.equal(result.body.settled,true);assert.equal(result.body.actualCredits,18);assert.equal(result.body.actualNativeCnyMicros,12);assert.equal(result.body.supplierDebitReference,'debit-'+r.id);
  assert.equal(f.counters.claim,1);assert.equal(f.counters.settle,1);assert.equal(f.counters.oracle,1);assert.equal(f.settlementFacts[0].observedOnly,false);
  assert.equal(result.headers.get('cache-control'),'private, no-store');const text=JSON.stringify(result.body);assert.ok(!text.includes(bridgeKey));assert.ok(!text.includes('fixture-customer-token'));assert.ok(!Object.hasOwn(result.body,'invoice_id'));assert.ok(!Object.hasOwn(result.body,'input_credits_per_million'));
});
test('duplicate reserve/claim and changed or foreign signed binding cannot dispatch again',async()=>{
  const f=fixture(),b=binding(),first=await response(f.handler,{action:'reserve',...b}),r=first.body;
  assert.equal((await response(f.handler,{action:'reserve',...b})).status,409);
  assert.equal((await response(f.handler,wire('claim',r,{payloadHash:'f'.repeat(64)}))).status,409);
  assert.equal((await response(f.handler,wire('claim',r,{receipt:{...r.receipt,signature:'0'.repeat(64)}}))).status,401);
  assert.equal((await response(f.handler,wire('claim',r,{receipt:{...r.receipt,owner:'test:supabase:'+OTHER}}))).status,401);
  assert.equal((await response(f.handler,wire('claim',r))).status,200);assert.equal((await response(f.handler,wire('claim',r))).status,409);assert.equal(f.counters.oracle,0);
});
test('retired configured key cannot claim an old signed reservation but known liability can still reconcile',async()=>{
  const f=fixture(),r=await reservation(f),retired=createAaroUsageBridge({...f.config,keyReference:'retired-policy-key'});
  assert.equal((await response(retired,wire('claim',r))).status,409);assert.equal(f.counters.claim,0);
  assert.equal((await response(f.handler,wire('claim',r))).status,200);assert.equal((await response(retired,settleBody(r))).body.settled,true);
});
test('settled replay avoids duplicate oracle work; changed usage cannot reuse completed receipt',async()=>{
  const f=fixture(),r=await executing(f);await response(f.handler,settleBody(r));const replay=await response(f.handler,settleBody(r));assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(f.counters.oracle,1);assert.equal(f.counters.settle,1);
  assert.equal((await response(f.handler,{...settleBody(r),inputTokens:11})).status,409);
});
test('caller-invalid token counts/debit metadata cannot reach the trusted supplier oracle',async()=>{
  const f=fixture(),r=await executing(f);
  for(const patch of [{inputTokens:101},{outputTokens:21},{inputTokens:0},{inputTokens:'10'},{actualNativeCnyMicros:0},{supplierDebitReference:'invented'},{observedOnly:true}])assert.notEqual((await response(f.handler,{...settleBody(r),...patch})).status,200);
  assert.equal(f.counters.oracle,0);assert.equal(f.counters.settle,0);assert.equal(f.records.get(r.id).state,'executing');
});
test('trusted supplier usage overrun or disagreement reaches quarantine with actual native liability',async()=>{
  for(const patch of [{inputTokens:101,outputTokens:21,actualNativeCnyMicros:250},{inputTokens:9,outputTokens:1,actualNativeCnyMicros:0}]){
    const f=fixture();f.config.reconcileSupplierDebit=async args=>({...await f.oracle(args),...patch});const r=await executing(f);const result=await response(f.handler,settleBody(r));
    assert.equal(result.status,200);assert.equal(result.body.settled,false);assert.equal(result.body.code,'NATIVE_LIABILITY_REQUIRES_RECONCILIATION');assert.equal(f.counters.oracle,1);assert.equal(f.counters.settle,1);
    assert.equal(f.settlementFacts[0].inputTokens,patch.inputTokens);assert.equal(f.settlementFacts[0].outputTokens,patch.outputTokens);assert.equal(f.settlementFacts[0].actualNativeCnyMicros,patch.actualNativeCnyMicros);assert.equal(f.settlementFacts[0].observedOnly,true);
    assert.equal(f.records.get(r.id).actual_credits,0);assert.equal(f.records.get(r.id).state,'uncertain');
  }
});
test('foreign, missing or invalid supplier debit evidence holds work without a customer settlement',async()=>{
  for(const patch of [{owner:'test:supabase:'+OTHER},{keyReference:'tooling-key'},{reservationId:randomUUID()},{model:'different/model'},{reconciliationReceiptSHA256:'invented'},{actualNativeCnyMicros:-1},{inputTokens:1000000001},{extra:'unverified'}]){
    const f=fixture();f.config.reconcileSupplierDebit=async args=>({...await f.oracle(args),...patch});const r=await executing(f);const result=await response(f.handler,settleBody(r));assert.notEqual(result.status,200);assert.equal(f.counters.settle,0);assert.equal(f.records.get(r.id).state,'executing');
  }
});
test('receipt-bound uncertain preserves claimed work without fresh customer bearer or automatic release',async()=>{
  const f=fixture(),r=await executing(f),body={action:'uncertain',protocol:AARO_PROTOCOL,product:'aaro',id:r.id,receipt:r.receipt};
  const result=await response(f.handler,body,{headers:{authorization:''}});assert.equal(result.status,200);assert.equal(result.body.held,true);assert.equal(result.body.state,'uncertain');
  assert.equal((await response(f.handler,{...body,action:'failed'})).status,400);assert.equal((await response(f.handler,{...body,action:'expire'})).status,400);assert.equal(f.counters.oracle,0);
});
test('aborted admission performs no customer or ledger operation',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();const result=await response(f.handler,{action:'reserve',...binding()},{signal:controller.signal});assert.equal(result.status,504);assert.equal(f.counters.verify,0);assert.equal(f.counters.reserve,0);
});
test('late read after receipt validation cannot claim or change a hold following caller abort',async()=>{
  for(const action of ['claim','uncertain']){
    const f=fixture(),r=await reservation(f),originalRead=f.rpc.read;
    f.rpc.read=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,35));return originalRead(...args);};
    const controller=new AbortController(),body=action==='claim'?wire('claim',r):{action:'uncertain',protocol:AARO_PROTOCOL,product:'aaro',id:r.id,receipt:r.receipt};
    const pending=response(f.handler,body,{signal:controller.signal});setTimeout(()=>controller.abort(),5);const result=await pending;
    assert.equal(result.status,504);assert.equal(f.counters.claim,0);assert.equal(f.counters.uncertain,0);assert.equal(f.records.get(r.id).state,'reserved');
  }
});
test('RPC transport fixes project, uses modern secret only server-side and maps only trusted function names',async()=>{
  const calls=[],secretKey='sb_secret_'+ 's'.repeat(32),publishableKey='sb_publishable_'+ 'p'.repeat(32);
  const rpc=createAaroUsageRpc({secretKey,publishableKey,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/auth/v1/user')?{id:USER,is_anonymous:false,email_confirmed_at:new Date().toISOString()}:{fixture:true});}}),signal=AbortSignal.timeout(1000),b=binding(),id=randomUUID();
  assert.deepEqual(await rpc.verifyCustomer('fixture-token',signal),{id:USER});await rpc.reserve(owner,b,signal);await rpc.read(owner,id,signal);await rpc.claim(owner,id,b,signal);await rpc.settle(owner,id,b,{fixture:true},signal);await rpc.uncertain(owner,id,signal);await rpc.expire(owner,id,signal);
  assert.equal(calls.length,7);assert.equal(calls[0].url,AARO_SUPABASE_ORIGIN+'/auth/v1/user');assert.equal(calls[0].options.headers.apikey,publishableKey);assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-token');
  assert.deepEqual(calls.slice(1).map(c=>c.url.split('/').at(-1)),['aaro_usage_reserve_v1','aaro_usage_read_v1','aaro_usage_claim_v1','aaro_usage_settle_v1','aaro_usage_uncertain_v1','aaro_usage_expire_v1']);
  for(const call of calls.slice(1)){assert.ok(call.url.startsWith(AARO_SUPABASE_ORIGIN+'/rest/v1/rpc/'));assert.equal(call.options.headers.apikey,secretKey);assert.equal(call.options.headers.Authorization,undefined);assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');assert.equal(call.options.method,'POST');}
});
test('RPC refuses wrong project/role secrets and unconfirmed, anonymous or malformed customer responses',async()=>{
  const jwt=claims=>'e30.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture',publishableKey='sb_publishable_'+ 'p'.repeat(32),secretKey='sb_secret_'+ 's'.repeat(32);
  for(const claims of [{ref:'wrong-project',role:'service_role'},{ref:'yautmilnpllojugpmfgy',role:'anon'}])assert.throws(()=>createAaroUsageRpc({secretKey:jwt(claims),publishableKey,fetchImpl:async()=>{throw Error('must not fetch');}}));
  for(const patch of [{id:'invalid'},{is_anonymous:true},{is_anonymous:undefined},{email_confirmed_at:null}]){
    const rpc=createAaroUsageRpc({secretKey,publishableKey,fetchImpl:async()=>Response.json({id:USER,is_anonymous:false,email_confirmed_at:new Date().toISOString(),...patch})});await assert.rejects(rpc.verifyCustomer('fixture-token',AbortSignal.timeout(1000)),e=>e.code==='UNVERIFIED_CUSTOMER');
  }
});
test('RPC rejects oversized/non-JSON/private-secret replies and keeps untrusted database error text private',async()=>{
  const secretKey='sb_secret_'+ 's'.repeat(32),publishableKey='sb_publishable_'+ 'p'.repeat(32);
  for(const responseFactory of [()=>new Response('oops',{headers:{'content-type':'text/plain'}}),()=>Response.json({padding:'x'.repeat(16385)}),()=>Response.json({secret:secretKey}),()=>Response.json({code:'P0001',message:'raw database credential '+secretKey},{status:400})]){
    const rpc=createAaroUsageRpc({secretKey,publishableKey,fetchImpl:async()=>responseFactory()});await assert.rejects(rpc.reserve(owner,binding(),AbortSignal.timeout(1000)),e=>!e.message.includes(secretKey));
  }
  const rpc=createAaroUsageRpc({secretKey,publishableKey,fetchImpl:async()=>Response.json({code:'P0001',message:'aaro_native_budget_exhausted'},{status:400})});await assert.rejects(rpc.reserve(owner,binding(),AbortSignal.timeout(1000)),e=>e.code==='aaro_native_budget_exhausted'&&e.status===402);
});
test('strict binding prohibits JSON null, mixed owner/mode and total-cap enlargement',()=>{
  for(const patch of [{protocol:null},{owner:'live:supabase:'+USER},{totalCapNativeCnyMicros:50000001},{requestKey:'small'},{acceptanceReceiptSHA256:'not-a-receipt'},{unexpected:true}])assert.throws(()=>validateAaroBinding(binding(patch)));
});

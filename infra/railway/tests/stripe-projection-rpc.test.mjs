// Offline synthetic fixtures only. All HTTP is injected; no env keys or DBs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createStripeProjectionRpc} from '../runtime/stripe-projection-rpc.mjs';
import {SUPABASE_ORIGIN} from '../runtime/supabase-gateway-rpc.mjs';
import {STRIPE_ACCOUNTS,PROJECTION_RPC} from '../runtime/stripe-financial-projection.mjs';
const secret='sb_secret_OFFLINEFIXTURENOTAREALCREDENTIAL';
const order='12345678-1234-4123-8123-123456789abc';
const base=()=>({p_account_id:STRIPE_ACCOUNTS.live,p_billing_mode:'live',p_event_id:'evt_Fixture',p_event_type:'checkout.session.completed',
  p_event_digest:'a'.repeat(64),p_event_created:2000000000,p_operation:'checkout',p_fact:{order_id:order,session_id:'cs_live_Fixture',
    customer_id:'cus_Fixture',payment_intent:'pi_Fixture',currency:'usd',subtotal_cents:2500,total_cents:2800,tax_cents:300,
    discount_cents:0,status:'complete',payment_status:'paid'}});
const receipt=(p=base())=>({applied:true,replayed:false,event_id:p.p_event_id,operation:p.p_operation});
const json=(v=receipt(),extra={})=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'},...extra});
function fixture(extra={}){
  const calls=[];const config={enabled:true,supabaseOrigin:SUPABASE_ORIGIN,secretKey:secret,billingMode:'live',accountId:STRIPE_ACCOUNTS.live,
    timeoutMs:1000,fetchImpl:async(url,options)=>{calls.push({url,options});return json(receipt(JSON.parse(options.body)));},...extra};
  return {client:createStripeProjectionRpc(config),calls,config};
}
await test('disabled transport cannot read credentials or call HTTP',async()=>{
  let calls=0;const client=createStripeProjectionRpc({fetchImpl:()=>calls++});
  await assert.rejects(client(PROJECTION_RPC,base()),/stripe_projection_disabled/);assert.equal(calls,0);
});
await test('exact project/original account/service credential/mode required',()=>{
  const jwt=claims=>'e30.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.OfflineSignature';
  for(const extra of [{supabaseOrigin:SUPABASE_ORIGIN+'/'},{supabaseOrigin:'https://bheheypylmibuicqtywx.supabase.co'},
    {supabaseOrigin:'http://127.0.0.1:3100'},{supabaseOrigin:'https://user@'+new URL(SUPABASE_ORIGIN).host},
    {accountId:'acct_other'},{billingMode:'test'},{secretKey:'sb_publishable_NOTASERVERCREDENTIAL'},
    {secretKey:jwt({role:'anon',ref:'yautmilnpllojugpmfgy'})},{secretKey:jwt({role:'service_role',ref:'wrong'})},
    {enabled:'true'},{timeoutMs:25001},{timeoutMs:0},{sql:'arbitrary'}, {fetchImpl:7}])assert.throws(()=>fixture(extra));
});
await test('fixed endpoint POST snapshot with modern secret apikey only, no bearer/server owner metadata',async()=>{
  const f=fixture(),p=base();const pending=f.client(PROJECTION_RPC,p);p.p_fact.subtotal_cents=1;p.p_event_id='evt_Mutated';
  assert.deepEqual(await pending,receipt());assert.equal(f.calls.length,1);
  const {url,options}=f.calls[0];assert.equal(url,SUPABASE_ORIGIN+'/rest/v1/rpc/'+PROJECTION_RPC);
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.equal(options.headers.apikey,secret);assert.equal(Object.hasOwn(options.headers,'authorization'),false);
  assert.equal(options.headers['content-profile'],'public');assert.deepEqual(JSON.parse(options.body),base());
  assert.equal(options.body.includes(secret),false);assert.equal(options.body.includes('p_owner'),false);
});
await test('legacy service JWT only for exact project uses Authorization in addition to apikey',async()=>{
  const token='e30.'+Buffer.from(JSON.stringify({role:'service_role',ref:'yautmilnpllojugpmfgy'})).toString('base64url')+'.OfflineSignature';
  const f=fixture({secretKey:token});await f.client(PROJECTION_RPC,base());assert.equal(f.calls[0].options.headers.authorization,'Bearer '+token);
});
await test('RPC name/owner/extra fields/accessors/prototypes/fractional or wrong namespace facts rejected before HTTP',async()=>{
  const f=fixture();await assert.rejects(f.client('arbitrary_sql',base()));
  const getter=base();Object.defineProperty(getter,'p_event_id',{enumerable:true,get(){throw new Error('getter executed');}});
  const facts=[{...base(),p_owner:'attacker'},Object.assign(Object.create({}),base()),getter,{...base(),p_fact:{...base().p_fact,user_id:order}},
    {...base(),p_billing_mode:'test'},{...base(),p_account_id:'acct_other'},{...base(),p_event_created:1.1},{...base(),p_event_created:NaN},
    {...base(),p_event_created:Number.MAX_SAFE_INTEGER+1},{...base(),p_event_digest:'bad'}, {...base(),p_operation:'__proto__'},
    {...base(),p_event_type:'invoice.paid'}, {...base(),p_fact:{...base().p_fact,session_id:'cs_test_Fixture'}},
    {...base(),p_fact:{...base().p_fact,total_cents:2801}},{...base(),p_fact:{...base().p_fact,discount_cents:1}},
    {...base(),p_fact:{...base().p_fact,subtotal_cents:1.5}},{...base(),p_fact:{...base().p_fact,currency:'cny'}},
    {...base(),p_fact:{...base().p_fact,payment_intent:null}},{...base(),p_fact:{...base().p_fact,status:'undefined'}},
    {...base(),p_fact:{...base().p_fact,customer_id:'cus_'+ 'x'.repeat(129)}}];
  for(const p of facts)await assert.rejects(f.client(PROJECTION_RPC,p));
  await assert.rejects(f.client(PROJECTION_RPC,base(),{signal:{aborted:false}}));
  await assert.rejects(f.client(PROJECTION_RPC,base(),{timeoutMs:1}));assert.equal(f.calls.length,0);
});
await test('refund/dispute schemas and event mapping are exact, integer USD only',async()=>{
  const f=fixture(),common={order_id:order,customer_id:'cus_Fixture',payment_intent:'pi_Fixture',currency:'usd'};
  const refund={...base(),p_operation:'refund',p_event_type:'refund.updated',p_fact:{...common,received_cents:2800,refunded_cents:1400}};
  const dispute={...base(),p_operation:'dispute',p_event_type:'charge.dispute.created',p_fact:{...common,dispute_id:'dp_Fixture',amount_cents:1000,status:'needs_response'}};
  assert.equal((await f.client(PROJECTION_RPC,refund)).operation,'refund');assert.equal((await f.client(PROJECTION_RPC,dispute)).operation,'dispute');
  for(const p of [{...refund,p_event_type:'checkout.session.completed'}, {...refund,p_fact:{...refund.p_fact,refunded_cents:2801}},
    {...refund,p_fact:{...refund.p_fact,received_cents:0}}, {...refund,p_fact:{...refund.p_fact,payment_intent:null}},
    {...dispute,p_fact:{...dispute.p_fact,amount_cents:0}}, {...dispute,p_fact:{...dispute.p_fact,amount_cents:200000001}},
    {...dispute,p_fact:{...dispute.p_fact,status:'unknown'}}, {...dispute,p_fact:{...dispute.p_fact,source_id:'attacker'}}])await assert.rejects(f.client(PROJECTION_RPC,p));
  assert.equal(f.calls.length,2);
});
await test('receipt requires exact true/applied, boolean replay, original event/operation and no extra fields',async()=>{
  for(const result of [null,[],{}, {replayed:false,event_id:'evt_Fixture',operation:'checkout'}, {...receipt(),applied:false},
    {...receipt(),replayed:'false'}, {...receipt(),event_id:'evt_Other'}, {...receipt(),operation:'refund'}, {...receipt(),secret}]){
    const f=fixture({fetchImpl:async()=>json(result)});await assert.rejects(f.client(PROJECTION_RPC,base()),/stripe_rpc_unavailable/);
  }
  const f=fixture({fetchImpl:async()=>json({...receipt(),replayed:true})});assert.equal((await f.client(PROJECTION_RPC,base())).replayed,true);
});
await test('non-2xx/redirect/wrong URL/type/oversized/malformed/UTF8 upstream never leak secret or database text',async()=>{
  const redirected=json();Object.defineProperty(redirected,'redirected',{value:true});
  const wrongUrl=json();Object.defineProperty(wrongUrl,'url',{value:SUPABASE_ORIGIN+'/rest/v1/rpc/other'});
  const responses=[json({message:secret},{status:403}),redirected,wrongUrl,new Response(secret,{headers:{'content-type':'text/html'}}),
    new Response(Buffer.from([255]),{headers:{'content-type':'application/json'}}),new Response('{broken',{headers:{'content-type':'application/json'}}),
    new Response('{}',{headers:{'content-type':'application/json','content-length':'4097'}}),
    new Response('x'.repeat(4097),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'bad'}})];
  for(const response of responses){const f=fixture({fetchImpl:async()=>response});await assert.rejects(f.client(PROJECTION_RPC,base()),e=>e.message==='stripe_rpc_unavailable'&&!e.message.includes(secret));}
  await assert.rejects(fixture({fetchImpl:async()=>{throw new Error(secret);}}).client(PROJECTION_RPC,base()),/stripe_rpc_unavailable/);
});
await test('pre-aborted parent prevents HTTP; abort bounds noncooperative fetch without retries',async()=>{
  const controller=new AbortController();controller.abort();const f=fixture();await assert.rejects(f.client(PROJECTION_RPC,base(),{signal:controller.signal}),/stripe_rpc_deadline_exceeded/);assert.equal(f.calls.length,0);
  let calls=0;const live=new AbortController();const g=fixture({fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  const pending=g.client(PROJECTION_RPC,base(),{signal:live.signal});setTimeout(()=>live.abort(),10);
  await assert.rejects(pending,/stripe_rpc_deadline_exceeded/);assert.equal(calls,1);
});
await test('deadline bounds noncooperative fetch and streaming response; cancels body/no auto replay',async()=>{
  let calls=0,canceled=0;
  const f=fixture({timeoutMs:10,fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  await assert.rejects(f.client(PROJECTION_RPC,base()),/stripe_rpc_deadline_exceeded/);assert.equal(calls,1);
  const g=fixture({timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({cancel(){canceled++;}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(g.client(PROJECTION_RPC,base()),/stripe_rpc_deadline_exceeded/);assert.equal(canceled,1);
});
await test('late successful upstream after timeout cannot report applied or trigger retries',async()=>{
  let calls=0;const f=fixture({timeoutMs:5,fetchImpl:()=>{calls++;return new Promise(resolve=>setTimeout(()=>resolve(json()),25));}});
  await assert.rejects(f.client(PROJECTION_RPC,base()),/stripe_rpc_deadline_exceeded/);await new Promise(r=>setTimeout(r,35));assert.equal(calls,1);
});

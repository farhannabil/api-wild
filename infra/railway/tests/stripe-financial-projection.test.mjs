// Offline by default. Optional real PG18 fixtures require an explicitly supplied
// loopback port/module and a NEW apiwild-outbox-pg-* temporary cluster. No env
// database URL, production key, real Stripe call or paid route is accepted.
// node infra/railway/tests/stripe-financial-projection.test.mjs [PORT /absolute/pg/lib/index.js]
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createStripeFinancialProjection,verifyStripeSignature,STRIPE_ACCOUNTS,PROJECTION_RPC} from '../runtime/stripe-financial-projection.mjs';
const now=2000000000,secret='whsec_OfflineFixtureSecretNoRealCredential';
const order='12345678-1234-4123-8123-123456789abc',customer='22345678-1234-4123-8123-123456789abc';
const owner='live:supabase:'+customer,otherCustomer='32345678-1234-4123-8123-123456789abc';
const session={id:'cs_live_Fixture',mode:'payment',livemode:true,status:'complete',payment_status:'paid',customer:'cus_Fixture',currency:'usd',
  amount_subtotal:2500,amount_total:2800,total_details:{amount_tax:300,amount_discount:0},payment_intent:'pi_Fixture',client_reference_id:order,
  metadata:{order_id:order,funding_mode:'one_time'}};
const intent={id:'pi_Fixture',status:'succeeded',livemode:true,customer:'cus_Fixture',currency:'usd',amount_received:2800,metadata:{order_id:order,funding_mode:'one_time'}};
const copy=x=>structuredClone(x);
function envelope(type='checkout.session.completed',id=session.id,extra={}){
  const event={id:'evt_Fixture',type,livemode:true,created:now,data:{object:{id}},...extra};
  const rawBody=Buffer.from(JSON.stringify(event));
  const signature='t='+now+',v1='+createHmac('sha256',secret).update(String(now)+'.').update(rawBody).digest('hex');
  return {rawBody,signature};
}
function fixture(overrides={}){
  const calls=[],projects=[];
  const objects={account:{id:STRIPE_ACCOUNTS.live},['checkout/sessions/'+session.id]:copy(session),'payment_intents/pi_Fixture':copy(intent),
    'charges/ch_Fixture':{id:'ch_Fixture',payment_intent:'pi_Fixture',livemode:true,currency:'usd'},
    'refunds/re_Fixture':{id:'re_Fixture',payment_intent:'pi_Fixture',livemode:true,currency:'usd'},
    'refunds?payment_intent=pi_Fixture&limit=100':{object:'list',has_more:false,data:[]},
    'disputes/dp_Fixture':{id:'dp_Fixture',payment_intent:'pi_Fixture',livemode:true,currency:'usd',amount:1000,status:'needs_response'}};
  Object.assign(objects,overrides.objects||{});
  const config={enabled:true,billingMode:'live',accountId:STRIPE_ACCOUNTS.live,stripeSecretKey:('sk' + '_live_' + 'OFFLINEFIXTURENOTAREALKEY'),
    webhookSecret:secret,nowSeconds:()=>now,timeoutMs:1000,
    fetchImpl:async(url,options)=>{calls.push({url,options});const path=url.slice('https://api.stripe.com/v1/'.length);
      if(!Object.hasOwn(objects,path))throw new Error('Unexpected fixture path');
      return new Response(JSON.stringify(objects[path]),{headers:{'content-type':'application/json'}});},
    project:async(name,params)=>{projects.push({name,params});return {applied:true,replayed:false,event_id:params.p_event_id,operation:params.p_operation};},
    ...(overrides.config||{})};
  return {client:createStripeFinancialProjection(config),config,objects,calls,projects};
}

await test('default disabled adapter performs no reads/projection',async()=>{
  let n=0;const client=createStripeFinancialProjection({fetchImpl:()=>++n,project:()=>++n});
  await assert.rejects(client.handle(envelope()),/stripe_projection_disabled/);assert.equal(n,0);
});
await test('exact original account, mode and configuration; arbitrary account/secret namespace rejected',()=>{
  for(const config of [{accountId:'acct_wrong'},{billingMode:'test'},{stripeSecretKey:'sk_test_WRONGMODE'},{webhookSecret:'wrong'},
    {enabled:'true'},{project:null},{timeoutMs:25001},{unknown:'not accepted'}])assert.throws(()=>fixture({config}));
});
await test('signature authenticates raw bytes and timestamp; duplicate t/unsafe/stale/tampered refused',()=>{
  const raw=envelope();assert.equal(verifyStripeSignature(raw.rawBody,raw.signature,secret,now),true);
  assert.equal(verifyStripeSignature(raw.rawBody,raw.signature+',t='+now,secret,now),false);
  for(const t of [now-301,now+301,Number.MAX_SAFE_INTEGER+1])assert.equal(verifyStripeSignature(raw.rawBody,raw.signature,secret,t),false);
  assert.equal(verifyStripeSignature(Buffer.from(raw.rawBody.toString()+' '),raw.signature,secret,now),false);
  assert.equal(verifyStripeSignature(raw.rawBody,raw.signature,'whsec_different',now),false);
  assert.equal(verifyStripeSignature(raw.rawBody.toString(),raw.signature,secret,now),false);
  assert.equal(verifyStripeSignature(Buffer.alloc(1000001),raw.signature,secret,now),false);
});
await test('invalid signatures, oversized and malformed envelopes never call providers/RPC',async()=>{
  const f=fixture();for(const raw of [{...envelope(),signature:'bad'}, {...envelope(),rawBody:Buffer.alloc(1000001)},
    envelope(undefined,undefined,{id:'bad'}),envelope(undefined,undefined,{created:1.5})])await assert.rejects(f.client.handle(raw));
  assert.equal(f.calls.length,0);assert.equal(f.projects.length,0);
});
await test('unrelated products/events, Connect accounts, and wrong modes fail closed before reads',async()=>{
  const f=fixture();for(const raw of [envelope('invoice.paid'),envelope(undefined,undefined,{account:'acct_other'}),
    envelope(undefined,undefined,{livemode:false})])await assert.rejects(f.client.handle(raw));
  assert.equal(f.calls.length,0);assert.equal(f.projects.length,0);
});
await test('canonical original Stripe account is checked before any financial object',async()=>{
  const f=fixture({objects:{account:{id:'acct_other'}}});await assert.rejects(f.client.handle(envelope()),/stripe_account_mismatch/);
  assert.equal(f.calls.length,1);assert.equal(f.projects.length,0);
});
await test('checkout uses canonical session/PI, not event metadata; typed RPC contains no owner or secrets',async()=>{
  const f=fixture();const raw=envelope(undefined,undefined,{data:{object:{id:session.id,metadata:{order_id:'attacker',user_id:'attacker'}}}});
  assert.deepEqual(await f.client.handle(raw),{received:true,replayed:false});assert.equal(f.calls.length,3);
  const {name,params}=f.projects[0];assert.equal(name,PROJECTION_RPC);assert.equal(params.p_fact.order_id,order);
  assert.equal(params.p_fact.subtotal_cents,2500);assert.equal(params.p_fact.total_cents,2800);
  assert.equal(params.p_account_id,STRIPE_ACCOUNTS.live);assert.match(params.p_event_digest,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(params,'p_owner'),false);assert.equal(JSON.stringify(params).includes('sk_live_'),false);
  assert.equal(Object.isFrozen(params),true);assert.equal(Object.isFrozen(params.p_fact),true);
  for(const call of f.calls){assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');}
});
await test('canonical checkout amount/discount/status/PI/customer/order/product mismatches cannot project',async()=>{
  for(const changed of [{amount_subtotal:2500.1},{amount_total:2799},{currency:'bdt'},{mode:'subscription'},{livemode:false},
    {customer:'cus_wrong'},{client_reference_id:'wrong'},{metadata:{order_id:order,funding_mode:'subscription'}},
    {total_details:{amount_tax:300,amount_discount:1}},{payment_intent:null}]){
    const f=fixture();Object.assign(f.objects['checkout/sessions/'+session.id],changed);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
  }
  for(const changed of [{amount_received:2799},{currency:'bdt'},{livemode:false},{customer:'cus_wrong'},
    {status:'processing'},{metadata:{order_id:otherCustomer,funding_mode:'one_time'}}]){
    const f=fixture();Object.assign(f.objects['payment_intents/pi_Fixture'],changed);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
  }
});
await test('expired/unpaid canonical checkout grants no credit facts; null PI accepted only without paid status',async()=>{
  const f=fixture();Object.assign(f.objects['checkout/sessions/'+session.id],{status:'expired',payment_status:'unpaid',payment_intent:null});
  await f.client.handle(envelope('checkout.session.expired'));assert.equal(f.calls.length,2);assert.equal(f.projects[0].params.p_fact.status,'expired');
});
await test('refund projection fetches full canonical list and sums succeeded refunds only',async()=>{
  const f=fixture();f.objects['refunds?payment_intent=pi_Fixture&limit=100'].data=[
    {id:'re_one',payment_intent:'pi_Fixture',livemode:true,currency:'usd',status:'succeeded',amount:1400},
    {id:'re_two',payment_intent:'pi_Fixture',livemode:true,currency:'usd',status:'pending',amount:50}];
  await f.client.handle(envelope('charge.refunded','ch_Fixture'));
  assert.equal(f.projects[0].params.p_fact.refunded_cents,1400);assert.equal(f.projects[0].params.p_fact.received_cents,2800);
});
await test('real Stripe refund objects without livemode use verified event, account and PaymentIntent mode',async()=>{
  for(const [type,id] of [['refund.created','re_Fixture'],['charge.refunded','ch_Fixture']]){
    const f=fixture();delete f.objects['refunds/re_Fixture'].livemode;
    f.objects['refunds?payment_intent=pi_Fixture&limit=100'].data=[{id:'re_one',payment_intent:'pi_Fixture',currency:'usd',status:'succeeded',amount:1000}];
    await f.client.handle(envelope(type,id));assert.equal(f.projects[0].params.p_fact.refunded_cents,1000);
  }
  const f=fixture();delete f.objects['refunds/re_Fixture'].livemode;
  f.objects['payment_intents/pi_Fixture'].livemode=false;
  await assert.rejects(f.client.handle(envelope('refund.created','re_Fixture')));assert.equal(f.projects.length,0);
});
await test('refund paginated/duplicate/mixed-PI/mode/currency/oversized totals stay unprojected',async()=>{
  const valid={id:'re_one',payment_intent:'pi_Fixture',livemode:true,currency:'usd',status:'succeeded',amount:1400};
  for(const changes of [{has_more:true},{data:[valid,valid]},{data:[{...valid,payment_intent:'pi_other'}]},
    {data:[{...valid,livemode:false}]},{data:[{...valid,currency:'bdt'}]}, {data:[{...valid,amount:2801}]},
    {data:[{...valid,amount:1.5}]},{data:[{...valid,status:'unknown'}]}]){
    const f=fixture();Object.assign(f.objects['refunds?payment_intent=pi_Fixture&limit=100'],changes);
    await assert.rejects(f.client.handle(envelope('refund.updated','re_Fixture')));assert.equal(f.projects.length,0);
  }
});
await test('canonical dispute and its PI are cross-checked without trusting event status/amount',async()=>{
  const f=fixture();await f.client.handle(envelope('charge.dispute.created','dp_Fixture',{data:{object:{id:'dp_Fixture',status:'won',amount:1}}}));
  assert.equal(f.projects[0].params.p_fact.status,'needs_response');assert.equal(f.projects[0].params.p_fact.amount_cents,1000);
  for(const changed of [{amount:2801},{status:'unknown'},{livemode:false},{currency:'bdt'}]){
    const f=fixture();Object.assign(f.objects['disputes/dp_Fixture'],changed);
    await assert.rejects(f.client.handle(envelope('charge.dispute.updated','dp_Fixture')));assert.equal(f.projects.length,0);
  }
});
await test('RPC receipt must explicitly report exact successful event/operation; errors are redacted',async()=>{
  for(const result of [{applied:false,replayed:false,event_id:'evt_Fixture',operation:'checkout'},
    {applied:true,replayed:'false',event_id:'evt_Fixture',operation:'checkout'},
    {applied:true,replayed:false,event_id:'evt_other',operation:'checkout'},
    {applied:true,replayed:false,event_id:'evt_Fixture',operation:'refund'},
    {applied:true,replayed:false,event_id:'evt_Fixture',operation:'checkout',secret:'private'}]){
    const f=fixture({config:{project:async()=>result}});await assert.rejects(f.client.handle(envelope()));
  }
  const f=fixture({config:{project:async()=>{throw new Error('PRIVATE_FIXTURE_CREDENTIAL');}}});
  await assert.rejects(f.client.handle(envelope()),e=>e.message==='stripe_projection_unavailable'&&!e.message.includes('PRIVATE'));
});
await test('whole-operation deadline prevents a late read from starting any projection',async()=>{
  let n=0;const f=fixture({config:{timeoutMs:10,fetchImpl:()=>new Promise(resolve=>setTimeout(()=>resolve(new Response('{"id":"'+STRIPE_ACCOUNTS.live+'"}',
    {headers:{'content-type':'application/json'}})),35)),project:()=>{n++;}}});
  await assert.rejects(f.client.handle(envelope()),/stripe_deadline_exceeded/);await new Promise(r=>setTimeout(r,45));assert.equal(n,0);
});
await test('whole-operation deadline also bounds a noncooperative RPC; no automatic replay',async()=>{
  let n=0;const f=fixture({config:{timeoutMs:10,project:()=>{n++;return new Promise(()=>{});}}});
  await assert.rejects(f.client.handle(envelope()),/stripe_deadline_exceeded/);assert.equal(n,1);
});
await test('bounded response bytes/UTF8/content-type/redirect/non-2xx reject before projection',async()=>{
  for(const response of [new Response('x',{status:503}),new Response('{}',{headers:{'content-type':'text/html'}}),
    new Response(Buffer.from([0xff]),{headers:{'content-type':'application/json'}}),
    new Response('{}',{headers:{'content-type':'application/json','content-length':'1000001'}}),
    new Response('x'.repeat(1000001),{headers:{'content-type':'application/json'}})]){
    const f=fixture({config:{fetchImpl:async()=>response}});await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
  }
});
await test('body snapshot remains authenticated when caller mutates its original bytes during await',async()=>{
  const f=fixture(),raw=envelope();const pending=f.client.handle(raw);raw.rawBody.fill(0);await pending;assert.equal(f.projects.length,1);
});

if(process.argv[2]!==undefined){
  const port=Number(process.argv[2]);
  assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535&&process.argv[3],'Explicit isolated port/module required');
  const {Client}=createRequire(import.meta.url)(process.argv[3]);
  const options={host:'127.0.0.1',port,user:'outbox_test',database:'postgres',ssl:false,password:()=>'',connectionTimeoutMillis:5000,
    query_timeout:25000,options:'-c statement_timeout=20s -c lock_timeout=5s'};
  const admin=new Client(options);await admin.connect();
  const identity=(await admin.query("select current_setting('data_directory') as path,current_setting('server_version_num')::integer as version,current_user as owner")).rows[0];
  assert.match(identity.path.replaceAll('\\','/'),/\/Temp\/apiwild-outbox-pg-[A-Za-z0-9]+$/);assert.equal(identity.owner,'outbox_test');assert.equal(Math.floor(identity.version/10000),18);
  const database='stripe_test_'+randomUUID().replaceAll('-','');await admin.query('create database '+database);await admin.end();
  const db=new Client({...options,database});await db.connect();
  const wallClock=setTimeout(()=>{console.error('Isolated Stripe fixtures exceeded wall-clock');process.exit(124);},120000);wallClock.unref();
  const baseMigration=await readFile(new URL('../../../supabase/migrations/20261003060000_apiwild_gateway_portability.sql',import.meta.url),'utf8');
  const proposal=await readFile(new URL('../runtime/stripe-financial-projection.schema.sql',import.meta.url),'utf8');
  const params=(operation='checkout',changes={})=>({p_account_id:STRIPE_ACCOUNTS.live,p_billing_mode:'live',p_event_id:'evt_Fixture',
    p_event_type:operation==='checkout'?'checkout.session.completed':operation==='refund'?'charge.refunded':'charge.dispute.created',
    p_event_digest:'a'.repeat(64),p_event_created:now,p_operation:operation,
    p_fact:operation==='checkout'?{order_id:order,session_id:session.id,customer_id:session.customer,payment_intent:intent.id,currency:'usd',
      subtotal_cents:2500,total_cents:2800,tax_cents:300,discount_cents:0,status:'complete',payment_status:'paid'}:
      operation==='refund'?{order_id:order,customer_id:session.customer,payment_intent:intent.id,currency:'usd',received_cents:2800,refunded_cents:1400}:
      {order_id:order,customer_id:session.customer,payment_intent:intent.id,currency:'usd',dispute_id:'dp_Fixture',amount_cents:1000,status:'needs_response'},...changes});
  const sql='select public.apiwild_stripe_project($1,$2,$3,$4,$5,$6,$7,$8) as value';
  async function project(p=params(),client=db){return (await client.query(sql,[p.p_account_id,p.p_billing_mode,p.p_event_id,p.p_event_type,
    p.p_event_digest,p.p_event_created,p.p_operation,JSON.stringify(p.p_fact)])).rows[0].value;}
  async function reset(){
    await db.query('truncate apiwild_finance.stripe_projection_events,apiwild_finance.stripe_credit_entries,apiwild_finance.stripe_disputes,apiwild_finance.stripe_orders,apiwild_finance.gateway_outbox,apiwild_finance.gateway_requests,apiwild_finance.gateway_keys,apiwild_finance.gateway_accounts,apiwild_finance.provider_budgets');
    await db.query("insert into apiwild_finance.gateway_accounts(user_id,customer_id,billing_mode) values($1,$2,'live')",[owner,customer]);
    await db.query("insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents) values($1,$2,'live',$3,$4,$5,2500)",
      [order,owner,STRIPE_ACCOUNTS.live,session.id,session.customer]);
  }
  async function account(){return (await db.query('select funded_usd_micros,payment_hold_usd_micros from apiwild_finance.gateway_accounts where user_id=$1',[owner])).rows[0];}
  async function count(table){return Number((await db.query('select count(*) as n from apiwild_finance.'+table)).rows[0].n);}
  async function parallel(n,work){const clients=Array.from({length:n},()=>new Client({...options,database}));
    try{await Promise.all(clients.map(c=>c.connect()));return await Promise.allSettled(clients.map((c,i)=>work(c,i)));}finally{await Promise.all(clients.map(c=>c.end()));}}
  async function paid(){await project();}
  try{
    await db.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;
      create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean not null default false);
      create table customer_profiles(user_id uuid primary key references auth.users(id),onboarding_completed_at timestamptz);
      insert into auth.users values('${customer}',now(),false),('${otherCustomer}',now(),false);
      insert into customer_profiles select id,now() from auth.users;`);
    await test('PG proposal compiles/reapplies with private RLS and no seeded rows',async()=>{
      await db.query(baseMigration);await db.query(proposal);await db.query(proposal);
      for(const table of ['gateway_accounts','stripe_orders','stripe_projection_events','stripe_credit_entries','stripe_disputes'])assert.equal(await count(table),0);
      const fn=(await db.query("select prosecdef,proconfig from pg_proc where proname='apiwild_stripe_project'")).rows[0];
      assert.equal(fn.prosecdef,false);assert.ok(fn.proconfig.includes('search_path=""'));assert.ok(fn.proconfig.includes('lock_timeout=5s'));assert.ok(fn.proconfig.includes('statement_timeout=20s'));
      const privateFn=(await db.query("select prosecdef,proconfig from pg_proc where pronamespace='apiwild_finance'::regnamespace and proname='stripe_project_v1'")).rows[0];
      assert.equal(privateFn.prosecdef,true);assert.ok(privateFn.proconfig.includes('search_path=""'));
    });
    await test('PG customer roles deny RPC/tables; service can only project registered orders',async()=>{
      await reset();for(const role of ['anon','authenticated']){
        await db.query('set role '+role);try{await assert.rejects(project(),e=>e.code==='42501');await assert.rejects(db.query('select * from apiwild_finance.stripe_orders'),e=>e.code==='42501');
          await assert.rejects(db.query("select apiwild_finance.stripe_project_v1(null,null,null,null,null,null,null,null)"),e=>e.code==='42501');}finally{await db.query('reset role');}
      }
      await db.query('set role service_role');try{assert.equal((await project()).applied,true);await assert.rejects(db.query('select * from apiwild_finance.stripe_orders'),e=>e.code==='42501');}finally{await db.query('reset role');}
    });
    await test('PG unknown order/PI and unsigned owner fields create no balance or receipt',async()=>{
      await reset();const p=params();for(const fact of [{...p.p_fact,session_id:'cs_live_Unregistered'},{...p.p_fact,owner:'attacker'},
        {...p.p_fact,order_id:otherCustomer},{...p.p_fact,customer_id:'cus_other'}])await assert.rejects(project(params('checkout',{p_fact:fact})));
      assert.equal((await account()).funded_usd_micros,'0');assert.equal(await count('stripe_projection_events'),0);
      await assert.rejects(project(params('refund')),/stripe_order_unregistered/);
    });
    await test('PG 16 connections duplicate same envelope credit once, then same session new event credits zero',async()=>{
      await reset();const results=await parallel(16,client=>project(params(),client));assert.equal(results.filter(r=>r.status==='fulfilled').length,16);
      assert.equal(results.filter(r=>r.status==='fulfilled'&&!r.value.replayed).length,1);assert.equal(await count('stripe_credit_entries'),1);
      assert.equal((await account()).funded_usd_micros,'25000000');await project(params('checkout',{p_event_id:'evt_other'}));
      assert.equal(await count('stripe_credit_entries'),1);assert.equal((await account()).funded_usd_micros,'25000000');
    });
    await test('PG duplicate ID/different signed digest rejects without changing durable credit',async()=>{
      await reset();await paid();await assert.rejects(project(params('checkout',{p_event_digest:'b'.repeat(64)})),/stripe_event_conflict/);
      assert.equal(await count('stripe_credit_entries'),1);assert.equal((await account()).funded_usd_micros,'25000000');
    });
    await test('PG arbitrary account/live-test/product/session namespaces rejected',async()=>{
      await reset();for(const change of [{p_account_id:'acct_other'},{p_billing_mode:'test'},{p_event_type:'invoice.paid'},
        {p_operation:'arbitrary'},{p_event_created:null},{p_event_digest:'bad'}])await assert.rejects(project(params('checkout',change)));
      await assert.rejects(db.query("update apiwild_finance.stripe_orders set product='aaro'"),e=>e.code==='23514');
      await assert.rejects(db.query("update apiwild_finance.stripe_orders set session_id='cs_test_wrong'"),e=>e.code==='23514');
      assert.equal((await account()).funded_usd_micros,'0');
    });
    await test('PG null/fractional/unsafe money and bad tax/discount reject transactionally',async()=>{
      await reset();const p=params();for(const change of [{subtotal_cents:null},{subtotal_cents:1.5},{subtotal_cents:2501},{total_cents:2799},
        {total_cents:200000001},{tax_cents:-1},{discount_cents:1},{status:null},{payment_status:null},{payment_intent:null}])
        await assert.rejects(project(params('checkout',{p_fact:{...p.p_fact,...change}})));
      assert.equal(await count('stripe_credit_entries'),0);assert.equal(await count('stripe_projection_events'),0);
    });
    await test('PG pending/expired failure never grants credit, paid canonical later credits exactly once',async()=>{
      await reset();const p=params();await project(params('checkout',{p_fact:{...p.p_fact,status:'expired',payment_status:'unpaid',payment_intent:null}}));
      assert.equal((await account()).funded_usd_micros,'0');await project(params('checkout',{p_event_id:'evt_later'}));
      assert.equal((await account()).funded_usd_micros,'25000000');
    });
    await test('PG proportional tax refund, replay, lower stale snapshot and full refund',async()=>{
      await reset();await paid();await project(params('refund',{p_event_id:'evt_refund'}));assert.equal((await account()).funded_usd_micros,'12500000');
      await project(params('refund',{p_event_id:'evt_refund'}));await project(params('refund',{p_event_id:'evt_lower',p_fact:{...params('refund').p_fact,refunded_cents:700}}));
      assert.equal((await account()).funded_usd_micros,'12500000');
      await project(params('refund',{p_event_id:'evt_full',p_fact:{...params('refund').p_fact,refunded_cents:2800}}));
      assert.equal((await account()).funded_usd_micros,'0');assert.equal(await count('stripe_credit_entries'),3);
    });
    await test('PG concurrent monotone refund targets debit only the cumulative maximum',async()=>{
      await reset();await paid();const results=await parallel(12,(client,i)=>project(params('refund',{p_event_id:'evt_refund'+i,
        p_fact:{...params('refund').p_fact,refunded_cents:i%2?700:1400}}),client));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,12);assert.equal((await account()).funded_usd_micros,'12500000');
      assert.equal((await db.query('select sum(amount_cents)::text as sum from apiwild_finance.stripe_credit_entries')).rows[0].sum,'1250');
    });
    await test('PG refunds reject changed receipt/currency/PI/negative/fractional amounts',async()=>{
      await reset();await paid();const p=params('refund');for(const change of [{received_cents:2500},{refunded_cents:2801},{refunded_cents:-1},
        {refunded_cents:null},{refunded_cents:1.5},{currency:'bdt'},{payment_intent:'pi_other'}])
        await assert.rejects(project(params('refund',{p_event_id:'evt_invalid',p_fact:{...p.p_fact,...change}})));
      assert.equal((await account()).funded_usd_micros,'25000000');assert.equal(await count('stripe_projection_events'),1);
    });
    await test('PG dispute hold clamps purchase once, refund reduces it, won releases hold',async()=>{
      await reset();await paid();await project(params('dispute',{p_event_id:'evt_dp'}));assert.equal((await account()).payment_hold_usd_micros,'10000000');
      await project(params('dispute',{p_event_id:'evt_dp2',p_fact:{...params('dispute').p_fact,dispute_id:'dp_Second',amount_cents:2500}}));
      assert.equal((await account()).payment_hold_usd_micros,'25000000');
      await project(params('refund',{p_event_id:'evt_refund'}));assert.equal((await account()).payment_hold_usd_micros,'12500000');
      for(const [i,id] of ['dp_Fixture','dp_Second'].entries())await project(params('dispute',{p_event_id:'evt_win'+i,p_event_created:now+1,
        p_fact:{...params('dispute').p_fact,dispute_id:id,amount_cents:i?2500:1000,status:'won'}}));
      assert.equal((await account()).payment_hold_usd_micros,'0');assert.equal((await account()).funded_usd_micros,'12500000');
    });
    await test('PG terminal lost holds are absorbing; stale opens cannot override won/lost',async()=>{
      await reset();await paid();const f=params('dispute').p_fact;
      await project(params('dispute',{p_event_id:'evt_lost',p_fact:{...f,status:'lost'}}));
      await project(params('dispute',{p_event_id:'evt_old',p_event_created:now-1,p_fact:{...f,status:'under_review'}}));
      assert.equal((await account()).payment_hold_usd_micros,'10000000');
      await assert.rejects(project(params('dispute',{p_event_id:'evt_conflict',p_fact:{...f,status:'won'}})),/stripe_dispute_terminal_conflict/);
      assert.equal((await account()).payment_hold_usd_micros,'10000000');
    });
    await test('PG nonterminal dispute older event cannot regress newer snapshot; warning remains conservative hold',async()=>{
      await reset();await paid();const f=params('dispute').p_fact;
      await project(params('dispute',{p_event_id:'evt_new',p_fact:{...f,status:'warning_under_review'}}));
      await project(params('dispute',{p_event_id:'evt_old',p_event_created:now-1,p_fact:{...f,status:'needs_response'}}));
      assert.equal((await db.query('select status from apiwild_finance.stripe_disputes')).rows[0].status,'warning_under_review');
      assert.equal((await account()).payment_hold_usd_micros,'10000000');
    });
    await test('PG write failure rolls back credit, order, account and event together',async()=>{
      await reset();await db.query("create function public.fixture_stripe_fail() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_WRITE_FAIL'; end $$; create trigger fixture_stripe_fail before insert on apiwild_finance.stripe_projection_events for each row execute function public.fixture_stripe_fail()");
      try{await assert.rejects(project(),/SYNTHETIC_WRITE_FAIL/);assert.equal((await account()).funded_usd_micros,'0');assert.equal(await count('stripe_credit_entries'),0);
        assert.equal((await db.query('select received_cents from apiwild_finance.stripe_orders')).rows[0].received_cents,null);}finally{
        await db.query('drop trigger fixture_stripe_fail on apiwild_finance.stripe_projection_events;drop function public.fixture_stripe_fail()');}
      assert.equal((await project()).applied,true);
    });
    await test('PG repeated-read isolation rejected; shadow search path cannot redirect credit',async()=>{
      await reset();await db.query('begin isolation level repeatable read');try{await assert.rejects(project(),/stripe_isolation_unsupported/);}finally{await db.query('rollback');}
      await db.query('create temp table stripe_orders(id text);set search_path=pg_temp,public');try{await project();assert.equal((await account()).funded_usd_micros,'25000000');}finally{await db.query('reset search_path');}
    });
    await test('PG signed adapter through real RPC completes one canonical credit and durable replay',async()=>{
      await reset();const f=fixture({config:{project:async(name,p)=>{assert.equal(name,PROJECTION_RPC);return project(p);}}});
      assert.deepEqual(await f.client.handle(envelope()),{received:true,replayed:false});
      assert.deepEqual(await f.client.handle(envelope()),{received:true,replayed:true});assert.equal((await account()).funded_usd_micros,'25000000');
    });
    await test('PG pre-existing external holds are never cleared by this partial projection',async()=>{
      await reset();await db.query('update apiwild_finance.gateway_accounts set payment_hold_usd_micros=777');await paid();
      assert.equal((await account()).payment_hold_usd_micros,'777');
      await project(params('dispute',{p_event_id:'evt_hold'}));assert.equal((await account()).payment_hold_usd_micros,'10000777');
      await project(params('dispute',{p_event_id:'evt_won',p_event_created:now+1,p_fact:{...params('dispute').p_fact,status:'won'}}));
      assert.equal((await account()).payment_hold_usd_micros,'777');
    });
    await test('PG under-projected prior dispute hold requires reconciliation; cannot release money',async()=>{
      await reset();await paid();await project(params('dispute',{p_event_id:'evt_hold'}));
      await db.query('update apiwild_finance.gateway_accounts set payment_hold_usd_micros=1');
      await assert.rejects(project(params('dispute',{p_event_id:'evt_won',p_fact:{...params('dispute').p_fact,status:'won'}})),/stripe_hold_reconciliation_required/);
      assert.equal((await db.query('select status from apiwild_finance.stripe_disputes')).rows[0].status,'needs_response');
    });
    await test('PG sandbox order funds only its isolated test owner',async()=>{
      await reset();const testOwner='test:supabase:'+customer;
      await db.query("insert into apiwild_finance.gateway_accounts(user_id,customer_id,billing_mode) values($1,$2,'test')",[testOwner,customer]);
      const testOrder=randomUUID();await db.query("insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents) values($1,$2,'test',$3,'cs_test_Fixture','cus_test',2500)",[testOrder,testOwner,STRIPE_ACCOUNTS.test]);
      await project(params('checkout',{p_billing_mode:'test',p_account_id:STRIPE_ACCOUNTS.test,p_fact:{...params().p_fact,order_id:testOrder,
        session_id:'cs_test_Fixture',payment_intent:'pi_test',customer_id:'cus_test'}}));
      assert.equal((await account()).funded_usd_micros,'0');
      assert.equal((await db.query('select funded_usd_micros from apiwild_finance.gateway_accounts where user_id=$1',[testOwner])).rows[0].funded_usd_micros,'25000000');
    });
    await test('PG concurrent distinct orders serialize one owner funding total without lost updates',async()=>{
      await reset();const orders=Array.from({length:8},()=>randomUUID());
      for(const [i,id] of orders.entries())await db.query("insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents) values($1,$2,'live',$3,$4,$5,2500)",[id,owner,STRIPE_ACCOUNTS.live,'cs_live_'+i,session.customer]);
      const results=await parallel(8,(client,i)=>project(params('checkout',{p_event_id:'evt_distinct'+i,p_fact:{...params().p_fact,order_id:orders[i],
        session_id:'cs_live_'+i,payment_intent:'pi_distinct'+i}}),client));
      assert.equal(results.filter(x=>x.status==='fulfilled').length,8);assert.equal((await account()).funded_usd_micros,'200000000');
      assert.equal(await count('stripe_credit_entries'),8);
    });
    await test('PG paid funding admits gateway work; full refund blocks a prior unclaimed reservation',async()=>{
      await reset();const budget=randomUUID();await db.query("insert into apiwild_finance.provider_budgets(id,product,billing_mode,key_reference,accepted,total_limit_cny_micros,daily_limit_cny_micros,rate_version,models) values($1,'apiwild','live',$2,true,50000000,50000000,'SYNTHETIC-ONLY',array['fixture/chat'])",[budget,randomUUID()]);
      const reservation=[owner,null,budget,'request-financial-fixture','a'.repeat(64),'chat','fixture/chat','SYNTHETIC-ONLY',1000,1000];
      const reserveSql='select public.apiwild_gateway_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as value';
      await assert.rejects(db.query(reserveSql,reservation),/gateway_customer_limit/);await paid();
      const r=(await db.query(reserveSql,reservation)).rows[0].value.record;
      await project(params('refund',{p_event_id:'evt_full',p_fact:{...params('refund').p_fact,refunded_cents:2800}}));
      await assert.rejects(db.query('select public.apiwild_gateway_claim($1,$2,$3)',[owner,r.id,r.version]),/gateway_customer_limit/);
      assert.equal((await account()).funded_usd_micros,'0');
    });
    console.log(JSON.stringify({database,postgresVersion:identity.version,clusterPath:identity.path,externalCalls:0,productionApplied:false,
      proposalRegistered:false,realPaymentAcceptance:false,runtimeActivated:false}));
  }finally{clearTimeout(wallClock);await db.end();}
}

// Isolated in-memory PostgreSQL. Explicit path to pinned PGlite required.
// No environment credentials, remote database, production query or network call.
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();
const root=fileURLToPath(new URL('../../../',import.meta.url));
let checks=0;
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
const customer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='test:supabase:'+customer;
const account='acct_1UCiHk0SGcPsf6AA';
const asService=async(sql,args=[])=>{await db.exec('set role service_role');try{return await db.query(sql,args);}finally{await db.exec('reset role');}};
const call=async(name,args,types)=> (await asService('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)+(types?.[i]?'::'+types[i]:'')).join(',')+') r',args)).rows[0].r;
const claim=id=>call('apiwild_allowance_claim',[owner,id]);
const row=async id=>(await db.query('select * from apiwild_finance.supplier_allowance_outbox where order_id=$1',[id])).rows[0];
let serial=0;
async function order({mapping=true,pay=true,accepted=true}={}){
  serial++;const id=randomUUID(),suffix=String(serial),session='cs_test_fixture'+suffix,pi='pi_fixture'+suffix;
  await db.query("insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents) values($1,$2,'test',$3,$4,'cus_fixture',3000)",[id,owner,account,session]);
  if(mapping)await db.query(`insert into apiwild_finance.supplier_allowance_mapping(order_id,user_id,native_user_id,package_id,paid_credit_cents,expected_quota,quota_policy_sha256,code_reference,code_sha256,accepted)
    values($1,$2,123,42,3000,7654321,$3,$4,$5,$6)`,[id,owner,'a'.repeat(64),randomUUID(),createHash('sha256').update('fixture'+suffix).digest('hex'),accepted]);
  if(pay)await paid({id,session,pi,suffix});return {id,session,pi,suffix};
}
async function project(o,operation,type,fact){return call('apiwild_stripe_project',[account,'test','evt_'+o.suffix+operation+type.replaceAll('.',''),type,'a'.repeat(64),100,operation,fact]);}
async function paid(o){return project(o,'checkout','checkout.session.completed',{order_id:o.id,session_id:o.session,customer_id:'cus_fixture',payment_intent:o.pi,currency:'usd',subtotal_cents:3000,total_cents:3000,tax_cents:0,discount_cents:0,status:'complete',payment_status:'paid'});}
async function refund(o){return project(o,'refund','charge.refunded',{order_id:o.id,customer_id:'cus_fixture',payment_intent:o.pi,currency:'usd',received_cents:3000,refunded_cents:1000});}
const finish=(id,version=1)=>call('apiwild_allowance_finish',[owner,id,version,{order_id:id,user_id:123,package_id:42,quota_redeemed:7654321,already_activated:false}]);
try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to service_role;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);
    create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
  for(const path of ['supabase/migrations/20261003060000_apiwild_gateway_portability.sql',
    'supabase/migrations/20261005010000_apiwild_stripe_projection.sql','supabase/migrations/20261005030000_retail_supplier_separation.sql',
    'supabase/migrations/20261005083727_supplier_allowance_outbox.sql'])await db.exec(fs.readFileSync(root+path,'utf8'));
  const proposal=fs.readFileSync(root+'infra/railway/runtime/supplier-allowance.schema.sql','utf8').split('\n').slice(1).join('\n');
  const migration=fs.readFileSync(root+'supabase/migrations/20261005083727_supplier_allowance_outbox.sql','utf8').split('\n').slice(1).join('\n');
  assert.equal(proposal,migration,'Reviewed schema and generated migration must differ only in their first comment.');
  await db.query('insert into auth.users values($1,now(),false)',[customer]);
  await db.query('select public.apiwild_gateway_account_initialize($1)',[owner]);
  await check('real Stripe projection atomically enqueues paid order, replay is one row',async()=>{
    const o=await order();assert.equal((await row(o.id)).state,'pending');await paid(o);
    assert.equal((await db.query('select count(*)::int n from apiwild_finance.supplier_allowance_outbox where order_id=$1',[o.id])).rows[0].n,1);
  });
  await check('unpaid/unmapped/unaccepted orders cannot be claimed',async()=>{
    const unpaid=await order({pay:false});assert.equal((await claim(unpaid.id)).claimed,false);
    const unmapped=await order({mapping:false});assert.equal((await row(unmapped.id)).state,'awaiting_mapping');assert.equal((await claim(unmapped.id)).claimed,false);
    const unaccepted=await order({accepted:false});assert.equal((await claim(unaccepted.id)).claimed,false);
  });
  await check('only one of concurrent claim attempts gets dispatch authority',async()=>{
    const o=await order();const results=await Promise.all([claim(o.id),claim(o.id),claim(o.id)]);
    assert.equal(results.filter(r=>r.claimed).length,1);assert.equal((await row(o.id)).state,'executing');
  });
  await check('foreign customer cannot claim an order',async()=>{
    const o=await order();await assert.rejects(call('apiwild_allowance_claim',['test:supabase:dddddddd-dddd-4ddd-8ddd-dddddddddddd',o.id]));
  });
  await check('exact activation is idempotent and receipt conflict fails',async()=>{
    const o=await order();await claim(o.id);assert.equal((await finish(o.id)).activated,true);assert.equal((await finish(o.id)).activated,true);
    assert.equal((await claim(o.id)).claimed,false);
    await assert.rejects(call('apiwild_allowance_finish',[owner,o.id,1,{order_id:o.id,user_id:999,package_id:42,quota_redeemed:7654321,already_activated:false}]));
  });
  await check('refund before claim blocks native activation',async()=>{
    const o=await order();await refund(o);assert.equal((await row(o.id)).state,'blocked');assert.equal((await claim(o.id)).claimed,false);
  });
  await check('refund after claim holds native uncertainty and suspends account',async()=>{
    const o=await order();await claim(o.id);await refund(o);
    assert.equal((await row(o.id)).state,'review');assert.equal((await finish(o.id)).activated,false);
    assert.equal((await db.query('select suspended from apiwild_finance.gateway_accounts where user_id=$1',[owner])).rows[0].suspended,true);
    await db.query('update apiwild_finance.gateway_accounts set suspended=false where user_id=$1',[owner]); // test isolation only
  });
  await check('dispute after activation marks review without pretending to revoke upstream credit',async()=>{
    const o=await order();await claim(o.id);await finish(o.id);
    await project(o,'dispute','charge.dispute.created',{order_id:o.id,customer_id:'cus_fixture',payment_intent:o.pi,currency:'usd',dispute_id:'dp_fixture'+o.suffix,amount_cents:3000,status:'needs_response'});
    assert.equal((await row(o.id)).state,'review');assert.ok((await row(o.id)).receipt);
    await db.query('update apiwild_finance.gateway_accounts set suspended=false,payment_hold_usd_micros=0 where user_id=$1',[owner]);
    await db.query("update apiwild_finance.stripe_disputes set status='won' where order_id=$1",[o.id]);
    await db.query('update apiwild_finance.gateway_accounts set suspended=false where user_id=$1',[owner]);
  });
  await check('expired and uncertain claims never redispatch',async()=>{
    const o=await order();await claim(o.id);
    await db.query("update apiwild_finance.supplier_allowance_outbox set claimed_at=now()-interval '1 minute' where order_id=$1",[o.id]);
    assert.equal((await call('apiwild_allowance_dispatch_guard',[owner,o.id,1])).dispatch,false);
    await call('apiwild_allowance_uncertain',[owner,o.id,1]);assert.equal((await claim(o.id)).claimed,false);
  });
  await check('mapping change cannot silently replace an already claimed native quota',async()=>{
    const o=await order();await claim(o.id);await db.query('update apiwild_finance.supplier_allowance_mapping set expected_quota=1 where order_id=$1',[o.id]);
    assert.equal((await call('apiwild_allowance_dispatch_guard',[owner,o.id,1])).dispatch,false);assert.equal((await row(o.id)).state,'review');
    await db.query('update apiwild_finance.gateway_accounts set suspended=false where user_id=$1',[owner]);
  });
  await check('public users have no RPC/table access; customer JWT rejected in server lane',async()=>{
    for(const role of ['anon','authenticated']){
      await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_allowance_claim($1,$2)',[owner,randomUUID()]));await db.exec('reset role');
    }
    await db.exec('set role service_role');await assert.rejects(db.query('select * from apiwild_finance.supplier_allowance_mapping'));await db.exec('reset role');
    const o=await order();await db.query("select set_config('request.jwt.claim.sub',$1,false)",[customer]);await assert.rejects(claim(o.id));
    await db.query("select set_config('request.jwt.claim.sub','',false)");
  });
  const budget=randomUUID(),keyRef=randomUUID();
  await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','test','CNY',$2,true,10000,10000,'v1',array['model'])",[budget,keyRef]);
  async function request(){const id=randomUUID();await db.query(`insert into apiwild_finance.gateway_requests(id,user_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,settlement_reference,result_json,expires_at,supplier_pending)
    values($1,$2,$3,$4,$5,'chat','model','v1','succeeded',100,800,$6,'{}',now()+interval '1 hour',true)`,[id,owner,budget,'request_'+id.replaceAll('-',''),'a'.repeat(64),'usage:response_'+id]);return id;}
  const fact=id=>({receipt_id:'receipt_'+id,key_reference:keyRef,upstream_response_id:'response_'+id,model:'model',currency:'CNY',cost_cny_micros:100});
  const reconcile=(id,f)=>call('apiwild_supplier_debit_apply',[owner,id,f,'a'.repeat(64)]);
  await check('actual supplier receipt releases hold once; conflicts/cross-request replay fail',async()=>{
    const id=await request();assert.equal((await reconcile(id,fact(id))).reconciled,true);assert.equal((await reconcile(id,fact(id))).replayed,true);
    await assert.rejects(reconcile(id,{...fact(id),cost_cny_micros:99}));
    const other=await request();await assert.rejects(reconcile(other,{...fact(other),receipt_id:fact(id).receipt_id}));
    assert.equal((await db.query('select supplier_pending from apiwild_finance.gateway_requests where id=$1',[other])).rows[0].supplier_pending,true);
  });
  await check('supplier overrun remains held and freezes provider budget',async()=>{
    const id=await request();assert.equal((await reconcile(id,{...fact(id),cost_cny_micros:801})).reconciled,false);
    assert.equal((await db.query('select supplier_pending from apiwild_finance.gateway_requests where id=$1',[id])).rows[0].supplier_pending,true);
    assert.equal((await db.query('select accepted from apiwild_finance.provider_budgets where id=$1',[budget])).rows[0].accepted,false);
  });
  console.log('PASS '+checks+' SQL integration checks; all operations used isolated in-memory PostgreSQL.');
}finally{await db.close();}

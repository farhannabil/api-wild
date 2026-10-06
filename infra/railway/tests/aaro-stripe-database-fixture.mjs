import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export async function runAaroStripeDatabaseTests({db,concurrent}){
const USER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const owner='test:supabase:'+USER,other='test:supabase:'+OTHER;
const checkout='33333333-3333-4333-8333-333333333333',account='acct_1UCiHk0SGcPsf6AA';
const start=Math.floor(Date.now()/1000),end=start+30*86400,sha='a'.repeat(64);
const call=async(name,params=[],client=db)=>(await client.query('select public.'+name+'('+params.map((_,i)=>'$'+(i+1)).join(',')+') as receipt',params)).rows[0].receipt;
const nativeFact=(patch={})=>({product:'aaro',checkoutId:checkout,customerId:'cus_fixture',subscriptionId:'sub_fixture',planReference:'global-starter',priceId:'price_1UJxSM194XZKj6cFHXqdKVq1',currency:'usd',amount:1500,subscriptionStatus:'active',invoiceId:'in_fixture',paid:true,processorVerified:true,periodStart:start,periodEnd:end,...patch});
const project=(fact=nativeFact(),{event='evt_fixture',operation='invoice',type='invoice.paid',digest=sha,mode='test',accountId=account,client=db}={})=>call('aaro_stripe_project_v1',[accountId,mode,event,type,digest,operation,fact],client);
async function reset(){
 await db.query('reset role');
 await db.query('truncate aaro_finance.accounts cascade');
 await db.query('update auth.users set email_confirmed_at=now(),is_anonymous=false');
 await call('aaro_billing_customer_v1',[owner,'cus_fixture']);
 await call('aaro_billing_customer_v1',[other,'cus_other']);
 return call('aaro_checkout_prepare_v1',[owner,checkout,'global-starter']);
}
 await db.query("create role anon nologin;create role authenticated nologin;create role service_role nologin;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean not null default false)");
 await db.query('insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now())',[USER,OTHER]);
 await db.query("create schema apiwild_finance;create table apiwild_finance.fixture_preserved(amount_usd_micros bigint);insert into apiwild_finance.fixture_preserved values(12345)");
 await db.query(await readFile(new URL('../runtime/aaro-usage.schema.sql',import.meta.url),'utf8'));
 await test('additive Stripe schema compiles with the usage protocol and grants no table access or funds',async()=>{
  await db.query(await readFile(new URL('../runtime/aaro-stripe.schema.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../runtime/aaro-billing-read.schema.sql',import.meta.url),'utf8'));
  const tables=(await db.query("select relname,relrowsecurity from pg_class where relnamespace='aaro_finance'::regnamespace and relkind='r'")).rows;
  assert.equal(tables.length,14);assert.ok(tables.every(t=>t.relrowsecurity));
  assert.equal((await db.query('select count(*) from aaro_finance.credit_periods')).rows[0].count,'0');
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_table_privilege($1,'aaro_finance.credit_periods','INSERT,UPDATE,DELETE') as permitted",[role])).rows[0].permitted,false);
 });
 await test('unconfirmed/anonymous/foreign customer mapping is denied; one confirmed owner stays frozen before funding',async()=>{
  await reset();assert.equal((await call('aaro_billing_read_v1',[owner])).frozen,true);
  await assert.rejects(call('aaro_billing_customer_v1',[owner,'cus_other']),e=>e.message==='aaro_customer_binding_conflict');
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[USER]);await assert.rejects(call('aaro_billing_customer_v1',[owner]));
  await db.query('update auth.users set email_confirmed_at=now(),is_anonymous=true where id=$1',[USER]);await assert.rejects(call('aaro_billing_customer_v1',[owner]));
 });
 await test('concurrent checkout requests preserve one owner order and reject another plan or session',async()=>{
  await reset();const attempts=await concurrent(8,(client)=>call('aaro_checkout_prepare_v1',[owner,randomUUID(),'global-starter'],client));
  assert.ok(attempts.every(x=>x.status==='fulfilled'&&x.value.id===checkout));
  await assert.rejects(call('aaro_checkout_prepare_v1',[owner,randomUUID(),'global-plus']));
  await call('aaro_checkout_record_v1',[owner,checkout,'cs_test_fixture']);
  await assert.rejects(call('aaro_checkout_record_v1',[other,checkout,'cs_test_other']));
  await assert.rejects(call('aaro_checkout_record_v1',[owner,checkout,null]));
  await assert.rejects(call('aaro_checkout_record_v1',[owner,checkout,'cs_test_other']));
 });
 await test('one paid invoice credits the separate fixed AARO period once; duplicate events preserve spent units',async()=>{
  await reset();const results=await concurrent(8,(client)=>project(nativeFact(),{client}));assert.ok(results.every(x=>x.status==='fulfilled'));
  assert.equal(results.filter(x=>!x.value.replayed).length,1);
  const info=await call('aaro_billing_read_v1',[owner]);assert.equal(info.frozen,false);assert.equal(info.creditPeriods.length,1);assert.equal(info.creditPeriods[0].credits,300000);
  assert.equal(info.creditPeriods[0].subscriptionId,'sub_fixture');
  await db.query("update aaro_finance.credit_periods set spent_credits=123 where invoice_id='in_fixture'");
  await project(nativeFact(),{event:'evt_second',digest:'b'.repeat(64)});
  assert.equal((await call('aaro_billing_read_v1',[owner])).creditPeriods[0].spentCredits,123);
  assert.equal((await db.query('select count(*) from aaro_finance.aggregate_budget')).rows[0].count,'0');
 });
 await test('wrong mode/account/product/customer/price/amount and unverified processor cannot grant units',async()=>{
  for(const patch of [{product:'apiwild'},{customerId:'cus_other'},{priceId:'price_other'},{amount:1},{processorVerified:false},{processorVerified:'true'},{checkoutId:null},{subscriptionStatus:null},{priceId:null}]){await reset();await assert.rejects(project(nativeFact(patch)));assert.equal((await call('aaro_billing_read_v1',[owner])).creditPeriods.length,0);}
  for(const opts of [{accountId:null},{mode:null},{accountId:'acct_foreign'},{mode:'live'}]){await reset();await assert.rejects(project(nativeFact(),opts));}
 });
 await test('event identity cannot be reused with another digest, operation or owner binding',async()=>{
  await reset();await project();await assert.rejects(project(nativeFact(),{digest:'b'.repeat(64)}));
  await assert.rejects(project(nativeFact(),{operation:'subscription',type:'customer.subscription.updated'}));
 });
 await test('refund/dispute holds before funding block later grants and survive new paid invoices',async()=>{
  await reset();const hold=nativeFact({sourceReference:'dp_fixture'});
  await project(hold,{event:'evt_hold',operation:'hold',type:'charge.dispute.created'});await project();
  const info=await call('aaro_billing_read_v1',[owner]);assert.equal(info.frozen,true);assert.equal(info.creditPeriods[0].frozen,true);
  await project(nativeFact({invoiceId:'in_renewal',periodStart:end,periodEnd:end+30*86400}),{event:'evt_renewal'});
  assert.equal((await call('aaro_billing_read_v1',[owner])).frozen,true);
 });
 await test('a refund after spending preserves units, requests and supplier state while freezing access',async()=>{
  await reset();await project();await db.query("update aaro_finance.credit_periods set spent_credits=100 where invoice_id='in_fixture'");
  await project(nativeFact({sourceReference:'re_fixture'}),{event:'evt_refund',operation:'hold',type:'refund.created'});
  const info=await call('aaro_billing_read_v1',[owner]);assert.equal(info.frozen,true);assert.equal(info.creditPeriods[0].spentCredits,100);assert.equal(info.creditPeriods[0].credits,300000);
 });
 await test('terminal subscriptions cannot be resurrected by a delayed paid invoice',async()=>{
  await reset();await project(nativeFact({subscriptionStatus:'canceled'}),{event:'evt_cancel',operation:'subscription',type:'customer.subscription.deleted'});
  await project();const info=await call('aaro_billing_read_v1',[owner]);assert.equal(info.subscriptions[0].status,'cancelled');assert.equal(info.creditPeriods.length,0);
 });
 await test('immutable invoice periods, overlap and concurrent duplicate periods cannot create extra units',async()=>{
  await reset();await project();await assert.rejects(project(nativeFact({periodEnd:end+1}),{event:'evt_changed'}));
  const attempts=await concurrent(4,(client,i)=>project(nativeFact({invoiceId:'in_overlap'+i}),{event:'evt_overlap'+i,client}));assert.ok(attempts.every(x=>x.status==='rejected'));
  assert.equal((await call('aaro_billing_read_v1',[owner])).creditPeriods.length,1);
 });
 await test('Bangladesh evidence is independent, accepted and unexpired; display currency cannot qualify a customer',async()=>{
  await reset();await db.query('update aaro_finance.checkout_bindings set active_owner=null');
  await assert.rejects(call('aaro_checkout_prepare_v1',[owner,randomUUID(),'bd-starter']));
  await db.query("insert into aaro_finance.region_evidence(owner,country,expires_at,receipt_sha256,accepted) values($1,'BD',now()+interval '1 hour',$2,false)",[owner,sha]);
  await assert.rejects(call('aaro_checkout_prepare_v1',[owner,randomUUID(),'bd-starter']));
  await db.query('update aaro_finance.region_evidence set accepted=true');const b=await call('aaro_checkout_prepare_v1',[owner,randomUUID(),'bd-starter']);assert.equal(b.plan.amount,45600);
  await db.query("update aaro_finance.region_evidence set expires_at=now()-interval '1 second'");assert.equal((await call('aaro_stripe_binding_read_v1',[null,b.id])).bangladeshEligible,false);
  assert.equal((await call('aaro_billing_read_v1',[owner])).bangladeshEligible,false);
 });
 await test('customer roles cannot project/grant funds; only service RPCs can write and API WILD stays preserved',async()=>{
  await reset();for(const role of ['anon','authenticated']){await db.query('set role '+role);try{await assert.rejects(project(),e=>e.code==='42501');}finally{await db.query('reset role');}}
  await db.query('set role service_role');try{await assert.rejects(db.query("update aaro_finance.accounts set frozen=false"),e=>e.code==='42501');assert.equal((await project()).applied,true);}finally{await db.query('reset role');}
  assert.equal((await db.query('select amount_usd_micros from apiwild_finance.fixture_preserved')).rows[0].amount_usd_micros,'12345');
 });

}

import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();let checks=0;
const customer=randomUUID(),owner='live:supabase:'+customer,budget=randomUUID(),reference=randomUUID();
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
async function call(name,args=[]){await db.exec('set role service_role');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;}finally{await db.exec('reset role');}}
const row=async id=>(await db.query('select * from apiwild_finance.gateway_requests where id=$1',[id])).rows[0];
async function reserve(usd=1000,cny=2000){return (await call('apiwild_gateway_reserve',[owner,null,budget,'fixture_'+randomUUID().replaceAll('-',''),'a'.repeat(64),'chat','claude-opus-4-6','v1',usd,cny])).record;}
async function finish(r,cost=37,state='succeeded'){const claimed=(await call('apiwild_gateway_claim',[owner,r.id,r.version])).record;const correlation=randomUUID();await call('apiwild_gateway_finish_retail',[owner,r.id,claimed.version,state,cost,0,'usage:'+correlation,{text:'fixture'},{providerRequestId:correlation,supplierSlug:'leapnode'}]);return {...r,correlation};}
function fact(r,quota=1){const n={quota,quota_unit_currency:'USD',quota_per_unit:500000,price:'6.8',usd_exchange_rate:'6.8',quota_display_type:'CNY',display_in_currency:true,settings_observed_at:'2026-10-05T00:00:00Z',settings_valid_until:'2026-11-04T00:00:00Z',settings_sha256:createHash('sha256').update('["subrouter-status-v1",500000,"CNY",true,"6.8","6.8"]').digest('hex'),log_id:123,log_created_at:1791201600,account_user_id:21872,token_id:123,provider_slug:'leapnode',billing_source:'wallet',billing_multiplier:1};return {receipt_id:'fixture_'+r.id,key_reference:reference,upstream_response_id:r.correlation,model:'claude-opus-4-6',currency:'CNY',cost_cny_micros:Math.ceil(quota*68/5),native_debit:n};}
const apply=(r,f=fact(r))=>call('apiwild_supplier_debit_apply',[owner,r.id,f,createHash('sha256').update(JSON.stringify(f)).digest('hex')]);
try{
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);");
 for(const name of ['20261003060000_apiwild_gateway_portability.sql','20261005010000_apiwild_stripe_projection.sql','20261005010100_apiwild_stripe_checkout.sql','20261005030000_retail_supplier_separation.sql','20261005031735_workspace_policy.sql','20261005032721_nullable_customer_key_limits.sql','20261005083727_supplier_allowance_outbox.sql','20261005103212_supplier_receipt_reader.sql','20261005104158_supplier_pending_list.sql','20261005121036_reservation_expiry_sweep.sql','20261005121900_bangai_request_identity.sql','20261005180000_credit_package_promotion.sql','20261012193000_gateway_active_concurrency.sql','20261012234347_native_customer_hourly_billing.sql','20261013010000_supplier_cost_five_times.sql'])await db.exec(fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1,now(),false)',[customer]);await call('apiwild_gateway_account_initialize',[owner]);
 await db.query('update apiwild_finance.gateway_accounts set funded_usd_micros=1000000 where user_id=$1',[owner]);
 await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','live','CNY',$2,true,50000000,50000000,'v1',array['claude-opus-4-6'])",[budget,reference]);
 await check('policy starts inactive; public/customer/internal function permissions retained',async()=>{
  assert.equal((await call('apiwild_customer_billing_policy')).active,false);
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_customer_billing_policy()'));await db.exec('reset role');}
  const grants=(await db.query("select has_function_privilege('service_role','public.apiwild_native_import(uuid,uuid,jsonb)','execute') native,has_function_privilege('service_role','public.apiwild_supplier_debit_apply(text,uuid,jsonb,text)','execute') receipt,has_function_privilege('service_role','apiwild_finance.settle_customer_cost5(text,uuid,jsonb,boolean)','execute') helper")).rows[0];assert.deepEqual(grants,{native:true,receipt:true,helper:false});
 });
 const old=await reserve(),oldFailed=await reserve();
 const cutoff=Math.floor(Date.now()/1000)-60;
 await db.query('update apiwild_finance.gateway_requests set created_at=to_timestamp($2) where id=$1',[old.id,cutoff-1]);
 await db.query('update apiwild_finance.customer_billing_policy set effective_at=to_timestamp($1)',[cutoff]);
 await check('activation immutable and historical reservation keeps original charge',async()=>{
  assert.equal((await call('apiwild_customer_billing_policy')).active,true);
  await assert.rejects(db.exec("update apiwild_finance.customer_billing_policy set effective_at=effective_at+interval '1 second'"),/billing_policy_immutable/);
  const r=await finish(old);assert.equal((await row(r.id)).cost_usd_micros,37);assert.equal((await apply(r)).reconciled,true);assert.equal((await row(r.id)).cost_usd_micros,37);
  const failed=await finish(oldFailed,0,'failed');assert.equal((await apply(failed,fact(failed,1))).reconciled,true);assert.equal((await row(failed.id)).cost_usd_micros,0);
 });
 await check('new gateway response charges zero and holds full reservation until validated receipt',async()=>{
  const r=await finish(await reserve());const pending=await row(r.id);assert.equal(pending.cost_usd_micros,0);assert.equal(pending.usage_json.customerChargePending,true);
  const usage=await call('apiwild_gateway_usage',[owner]);assert.equal(usage.reservedUsdMicros,1000);
  assert.equal((await call('apiwild_billing_read',[owner,null])).balanceCents,Math.floor(usage.availableUsdMicros/10000));
  await db.query('update apiwild_finance.gateway_accounts set funded_usd_micros=1037 where user_id=$1',[owner]);await assert.rejects(reserve(1,1),/gateway_customer_limit/);
  await db.query('update apiwild_finance.gateway_accounts set funded_usd_micros=1000000 where user_id=$1',[owner]);
  const f=fact(r,1);assert.equal((await apply(r,f)).reconciled,true);assert.equal((await apply(r,f)).replayed,true);
  const settled=await row(r.id);assert.equal(settled.cost_usd_micros,10);assert.equal(settled.cost_cny_micros,14);assert.equal(settled.usage_json.customerChargePending,false);assert.equal((await call('apiwild_gateway_usage',[owner])).reservedUsdMicros,0);
  assert.equal((await call('apiwild_billing_read',[owner,null])).balanceCents,Math.floor((await call('apiwild_gateway_usage',[owner])).availableUsdMicros/10000));
  const outbox=(await db.query('select payload from apiwild_finance.gateway_outbox where request_id=$1',[r.id])).rows[0].payload;assert.equal(outbox.cost_usd_micros,10);assert.equal(outbox.usage.customerChargePending,false);
  await assert.rejects(apply(r,fact(r,2)),/supplier_receipt_conflict/);
 });
 await check('new legacy path rejects missing quota and false normalized cost; zero cost exact',async()=>{
  const r=await finish(await reserve());const f=fact(r);delete f.native_debit;await assert.rejects(apply(r,f),/billing_native_quota_required/);
  await assert.rejects(apply(r,{...fact(r),cost_cny_micros:13}),/supplier_invalid_normalized_cost/);
  assert.equal((await row(r.id)).usage_json.customerChargePending,true);assert.equal((await apply(r,fact(r,0))).reconciled,true);assert.equal((await row(r.id)).cost_usd_micros,0);
 });
 await check('native receipt-created cutover preserves delayed old price and charges new quota times ten',async()=>{
  const k=randomUUID(),run=randomUUID();await call('apiwild_native_key_prepare',[owner,k,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),null,null,null,budget,918273645,'{"claude-opus-4-6":{"input":2500000,"output":12500000,"provider":"leapnode"}}']);await call('apiwild_native_key_attach',[owner,k,918273646]);await db.query('update apiwild_finance.native_customer_keys set created_at=to_timestamp($2) where key_id=$1',[k,cutoff-120]);assert.equal(await call('apiwild_native_sync_claim',[k,run]),true);
  const base={id:1,token:918273646,account:918273645,prompt:1000,completion:200,quota:100,created:cutoff-1,model:'claude-opus-4-6',provider:'leapnode'};
  const facts=[base,{...base,id:2,created:cutoff},{...base,id:3,created:cutoff,quota:1},{...base,id:4,created:cutoff,quota:0}];
  assert.equal((await call('apiwild_native_import',[k,run,facts])).imported,4);assert.equal((await call('apiwild_native_import',[k,run,facts])).imported,0);
  const rows=(await db.query('select n.log_id,r.cost_usd_micros,r.usage_json from apiwild_finance.native_usage_receipts n join apiwild_finance.gateway_requests r on r.id=n.request_id where n.key_id=$1 order by n.log_id',[k])).rows;
  assert.deepEqual(rows.map(r=>r.cost_usd_micros),[5000,1000,10,0]);assert.equal(rows[0].usage_json.billingPolicy,'reference-token-v1');assert.equal(rows[1].usage_json.billingPolicy,'supplier-cost-5x-v1');
 });
 await check('billing marker does not prevent expiry of undispatched reservations',async()=>{
  const before=(await call('apiwild_gateway_usage',[owner])).availableUsdMicros;
  const r=await reserve();await db.query("update apiwild_finance.gateway_requests set expires_at=clock_timestamp()-interval '1 second' where id=$1",[r.id]);
  const candidates=await call('apiwild_reservation_expiry_list',['live',[reference],null,null]);assert.ok(candidates.some(x=>x.requestId===r.id));
  await call('apiwild_gateway_expire',[owner,r.id,r.version]);assert.equal((await row(r.id)).state,'cancelled');
  assert.equal((await call('apiwild_gateway_usage',[owner])).availableUsdMicros,before);
 });
 await check('new failed response charges verified supplier cost; historical failed response stays free',async()=>{
  const before=(await call('apiwild_gateway_usage',[owner])).spentUsdMicros;
  const r=await finish(await reserve(),0,'failed');assert.equal((await row(r.id)).usage_json.customerChargePending,true);
  assert.equal((await apply(r,fact(r,2))).reconciled,true);assert.equal((await row(r.id)).state,'failed');assert.equal((await row(r.id)).cost_usd_micros,20);
  assert.equal((await call('apiwild_gateway_usage',[owner])).spentUsdMicros,before+20);
  assert.equal((await call('apiwild_billing_read',[owner,null])).balanceCents,Math.floor((await call('apiwild_gateway_usage',[owner])).availableUsdMicros/10000));
 });
 await check('$1 supplier cost deducts $5 from a $25 customer wallet, leaving $20',async()=>{
  const user=randomUUID(),own='live:supabase:'+user,k=randomUUID(),run=randomUUID();
  await db.query('insert into auth.users values($1,now(),false)',[user]);await call('apiwild_gateway_account_initialize',[own]);await db.query('update apiwild_finance.gateway_accounts set funded_usd_micros=25000000 where user_id=$1',[own]);
  await call('apiwild_native_key_prepare',[own,k,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),null,null,null,budget,928273645,'{"claude-opus-4-6":{"input":2500000,"output":12500000,"provider":"leapnode"}}']);await call('apiwild_native_key_attach',[own,k,928273646]);assert.equal(await call('apiwild_native_sync_claim',[k,run]),true);
  const f={id:1,token:928273646,account:928273645,prompt:1000000,completion:0,quota:500000,created:Math.floor(Date.now()/1000),model:'claude-opus-4-6',provider:'leapnode'};
  assert.equal((await call('apiwild_native_import',[k,run,[f]])).imported,1);await call('apiwild_native_sync_finish',[k,run,500000]);
  const usage=await call('apiwild_gateway_usage',[own]);assert.equal(usage.spentUsdMicros,5000000);assert.equal(usage.availableUsdMicros,20000000);assert.equal(usage.reservedUsdMicros,0);assert.equal((await call('apiwild_billing_read',[own,null])).balanceCents,2000);
 });
 await check('customer overrun preserves USD hold and freezes provider',async()=>{
  const r=await finish(await reserve(9,100));const result=await apply(r,fact(r,1));assert.equal(result.reconciled,false);assert.equal(result.reason,'customer_bound_exceeded');const held=await row(r.id);assert.equal(held.cost_usd_micros,0);assert.equal(held.usage_json.customerChargePending,true);assert.equal(held.supplier_pending,true);assert.equal((await call('apiwild_gateway_usage',[owner])).reservedUsdMicros,9);assert.equal((await db.query('select accepted from apiwild_finance.provider_budgets where id=$1',[budget])).rows[0].accepted,false);
 });
 await check('supplier overrun retains both reconciliation holds and exact observed liability',async()=>{
  await db.query('update apiwild_finance.provider_budgets set accepted=true where id=$1',[budget]);
  const r=await finish(await reserve(100,13));const result=await apply(r,fact(r,1));assert.equal(result.reconciled,false);assert.equal(result.reason,'supplier_bound_exceeded');const held=await row(r.id);assert.equal(held.cost_usd_micros,0);assert.equal(held.usage_json.customerChargePending,true);assert.equal(held.supplier_pending,true);assert.equal(held.observed_cny_micros,14);assert.equal((await call('apiwild_gateway_usage',[owner])).reservedUsdMicros,109);
 });
 console.log('PASS '+checks+' cost-five PostgreSQL acceptance checks. No external calls.');
}catch(e){console.error('FAIL',e.message,e.code??'',e.where??'');process.exitCode=1;}finally{await db.close();}



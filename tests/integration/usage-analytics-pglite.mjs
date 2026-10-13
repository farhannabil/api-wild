import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
async function call(name,args=[]){await db.exec('set role service_role');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;}finally{await db.exec('reset role');}}
const refresh=()=>db.query('select apiwild_finance.refresh_usage_dashboard()');
const audit=async()=>(await db.query('select apiwild_finance.audit_customer_billing() r')).rows[0].r;
const dash=owner=>call('apiwild_usage_dashboard',[owner]);
try{
 const baseline=fs.readFileSync(new URL('./supplier-cost-five-pglite.mjs',import.meta.url),'utf8');
 // Reuse precisely the deployed financial migration chain, without executing its tests.
 const names=[...baseline.matchAll(/'(2026[^']+\.sql)'/g)].map(x=>x[1]);
 assert.ok(names.includes('20261013010000_supplier_cost_five_times.sql'));
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);");
 for(const name of [...names,'20261013020000_usage_analytics_jobs.sql'])await db.exec(fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
 const budget=randomUUID(),reference=randomUUID(),owner='live:supabase:'+randomUUID(),other='live:supabase:'+randomUUID();
 for(const own of [owner,other]){await db.query('insert into auth.users values($1,now(),false)',[own.slice(14)]);await call('apiwild_gateway_account_initialize',[own]);await db.query('update apiwild_finance.gateway_accounts set funded_usd_micros=25000000 where user_id=$1',[own]);}
 await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','live','CNY',$2,true,50000000,50000000,'v1',array['claude-opus-4-6'])",[budget,reference]);
 await db.exec("update apiwild_finance.customer_billing_policy set effective_at=date_trunc('second',clock_timestamp())-interval '1 minute'");
 const key=randomUUID(),run=randomUUID();
 await call('apiwild_native_key_prepare',[owner,key,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),null,null,new Date(Date.now()+86400000).toISOString(),budget,918273645,{ 'claude-opus-4-6':{input:2500000,output:12500000,provider:'leapnode'}}]);
 await call('apiwild_native_key_attach',[owner,key,918273646]);assert.equal(await call('apiwild_native_sync_claim',[key,run]),true);
 const base={id:1,token:918273646,account:918273645,prompt:1000,completion:200,quota:500000,created:Math.floor(Date.now()/1000),model:'claude-opus-4-6',provider:'leapnode'};
 const facts=[base,{...base,id:2,prompt:10,completion:2,quota:0}];
 await call('apiwild_native_import',[key,run,facts]);
 const original=(await db.query('select * from apiwild_finance.native_usage_receipts order by log_id')).rows;
 const money=await call('apiwild_gateway_usage',[owner]);
 await check('permissions and owner-scoped projection',async()=>{
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_usage_dashboard($1)',[owner]));await assert.rejects(db.query('select * from apiwild_finance.usage_daily'));await db.exec('reset role');}
  const permissions=(await db.query("select has_function_privilege('service_role','apiwild_finance.refresh_usage_dashboard()','execute') refresh,has_function_privilege('service_role','apiwild_finance.audit_customer_billing()','execute') audit")).rows[0];assert.deepEqual(permissions,{refresh:false,audit:false});
  await refresh();assert.equal((await dash(other)).totals.requests,0);assert.equal((await dash(owner)).totals.requests,2);
 });
 await check('enrichment preserves billing identity and money; known zero differs from unknown',async()=>{
  await call('apiwild_native_usage_details',[key,run,[{fact:base,cacheReadTokens:0,cacheWriteTokens:null},{fact:facts[1],cacheReadTokens:null,cacheWriteTokens:7}]]);
  assert.deepEqual((await db.query('select * from apiwild_finance.native_usage_receipts order by log_id')).rows,original);
  assert.deepEqual(await call('apiwild_gateway_usage',[owner]),money);
  await refresh();const t=(await dash(owner)).totals;assert.equal(t.cacheReadKnown,1);assert.equal(t.cacheReadTokens,0);assert.equal(t.cacheWriteKnown,1);assert.equal(t.cacheWriteTokens,7);assert.equal(t.inputTokens,1010);assert.equal(t.outputTokens,202);
  assert.equal(t.chargedUsdMicros,5000000);assert.equal(money.availableUsdMicros,20000000);
 });
 await check('duplicate imports and projections do not double-count; conflicts and foreign facts reject',async()=>{
  assert.equal((await call('apiwild_native_import',[key,run,facts])).imported,0);
  await call('apiwild_native_usage_details',[key,run,[{fact:base,cacheReadTokens:0}]]);await refresh();await refresh();assert.equal((await dash(owner)).totals.chargedUsdMicros,5000000);
  await assert.rejects(call('apiwild_native_usage_details',[key,run,[{fact:base,cacheReadTokens:1}]]),/analytics_detail_conflict/);
  await assert.rejects(call('apiwild_native_usage_details',[key,run,[{fact:{...base,token:111},cacheReadTokens:0}]]),/analytics_receipt_invalid/);
  await assert.rejects(call('apiwild_native_usage_details',[key,randomUUID(),[{fact:base}]]),/analytics_lease_invalid/);
 });
 async function request(){return (await call('apiwild_gateway_reserve',[other,null,budget,'fixture_'+randomUUID().replaceAll('-',''),'a'.repeat(64),'chat','claude-opus-4-6','v1',1000000,1360000])).record;}
 const late=await request();
 await check('late settlement replaces pending bucket and cancellation removes stale buckets',async()=>{
  const claimed=(await call('apiwild_gateway_claim',[other,late.id,late.version])).record;
  await call('apiwild_gateway_finish_retail',[other,late.id,claimed.version,'succeeded',1,0,'usage:'+randomUUID(),{text:'fixture'},{prompt_tokens:20,completion_tokens:4}]);
  await refresh();assert.equal((await dash(other)).totals.pendingRequests,1);assert.equal((await dash(other)).totals.chargedUsdMicros,0);
  // Fixture simulates a later canonical settlement; billing settlement itself is tested separately.
  await db.query("update apiwild_finance.gateway_requests set cost_usd_micros=100,usage_json=usage_json||'{\"customerChargePending\":false,\"supplierUsdMicros\":20,\"extraFeeUsdMicros\":0}'::jsonb where id=$1",[late.id]);
  await refresh();assert.equal((await dash(other)).totals.chargedUsdMicros,100);assert.equal((await dash(other)).totals.pendingRequests,0);
  const cancelled=await request();await db.query("update apiwild_finance.gateway_requests set state='uncertain',created_at=clock_timestamp()-interval '1 day' where id=$1",[cancelled.id]);await refresh();assert.equal((await dash(other)).days.length,2);
  await db.query("update apiwild_finance.gateway_requests set state='cancelled' where id=$1",[cancelled.id]);await refresh();assert.equal((await dash(other)).days.length,1);assert.equal((await dash(other)).totals.requests,1);
 });
 await check('hourly audit detects fee and charge mismatches, stale key and overdue hold without billing mutations',async()=>{
  assert.equal((await audit()).mismatches,0);
  await db.query("update apiwild_finance.gateway_requests set usage_json=usage_json||'{\"extraFeeUsdMicros\":1}'::jsonb where id=$1",[original[0].request_id]);
  await db.query("update apiwild_finance.gateway_requests set cost_usd_micros=101 where id=$1",[late.id]);
  const pending=await request();await db.query("update apiwild_finance.gateway_requests set state='uncertain',usage_json=usage_json||'{\"customerChargePending\":true}'::jsonb,updated_at=clock_timestamp()-interval '3 hours' where id=$1",[pending.id]);
  await db.query("update apiwild_finance.native_customer_keys set created_at=clock_timestamp()-interval '3 hours',last_synced_at=null where key_id=$1",[key]);
  const before=(await db.query('select id,cost_usd_micros,usage_json from apiwild_finance.gateway_requests order by id')).rows;
  assert.deepEqual(await audit(),{mismatches:2,overdueRequests:1,staleKeys:1});
  assert.deepEqual((await db.query('select id,cost_usd_micros,usage_json from apiwild_finance.gateway_requests order by id')).rows,before);
  assert.equal((await dash(owner)).billingCheck.mismatches,1);assert.equal((await dash(other)).billingCheck.mismatches,1);
 });
 console.log('PASS '+checks+' usage analytics PostgreSQL checks. No external calls.');
}catch(e){console.error('FAIL',e.message,e.code??'',e.where??'');process.exitCode=1;}finally{await db.close();}

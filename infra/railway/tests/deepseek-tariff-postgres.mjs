// Actual SQL in isolated in-memory PostgreSQL, never a remote query.
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const root=fileURLToPath(new URL('../../../',import.meta.url));
let count=0;const check=async(name,fn)=>{await fn();console.log('PASS '+name);count++;};
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);
 create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
 for(const filename of ['20261003060000_apiwild_gateway_portability.sql','20261005030000_retail_supplier_separation.sql',
  '20261005031735_workspace_policy.sql','20261005032721_nullable_customer_key_limits.sql','20261005084607_deepseek_request_tariff_version.sql'])
  await db.exec(fs.readFileSync(root+'supabase/migrations/'+filename,'utf8'));
 const customer=randomUUID(),owner='test:supabase:'+customer,budget=randomUUID(),keyRef=randomUUID();
 await db.query('insert into auth.users values($1,now(),false)',[customer]);await db.query('select apiwild_gateway_account_initialize($1)',[owner]);
 await db.query('update apiwild_finance.gateway_accounts set funded_usd_micros=1000000000,daily_limit_usd_micros=1000000000 where user_id=$1',[owner]);
 await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','test','CNY',$2,true,50000000,50000000,'fixture-v1',array['deepseek-v4-flash','deepseek-v4-pro','standard-model'])",[budget,keyRef]);
 const reserve=async(model,version,requestKey='req_'+randomUUID().replaceAll('-',''))=>(await db.query('select apiwild_gateway_reserve($1,null,$2,$3,$4,$5,$6,$7,$8,$9) r',[owner,budget,requestKey,'a'.repeat(64),'chat',model,version,1000,500])).rows[0].r;
 await check('two DeepSeek models match accepted base while retaining complete frozen tier',async()=>{
  for(const [model,tier] of [['deepseek-v4-flash','off_peak'],['deepseek-v4-pro','peak']]){
   const r=await reserve(model,'fixture-v1:ds26:'+tier);assert.equal(r.record.rate_version,'fixture-v1:ds26:'+tier);
   const claim=(await db.query('select apiwild_gateway_claim($1,$2,$3) r',[owner,r.record.id,r.record.version])).rows[0].r;
   assert.equal(claim.claimed,true);assert.equal(claim.record.rate_version,r.record.rate_version);
   await db.query("update apiwild_finance.gateway_requests set state='cancelled' where id=$1",[r.record.id]);
  }
 });
 await check('unknown/malformed suffixes and absent tiers are rejected before reservation',async()=>{
  for(const version of ['fixture-v1','fixture-v1:ds26:peak:extra','fixture-v1:ds26:cheap','fixture-v1:ds27:peak','foreign:ds26:peak','fixture-v1:ds26:'])
   await assert.rejects(reserve('deepseek-v4-flash',version));
 });
 await check('standard model retains exact base matching and rejects DeepSeek suffix',async()=>{
  await assert.rejects(reserve('standard-model','fixture-v1:ds26:peak'));const r=await reserve('standard-model','fixture-v1');assert.equal(r.fresh,true);
  await db.query("update apiwild_finance.gateway_requests set state='cancelled' where id=$1",[r.record.id]);
 });
 await check('replayed request cannot change its recorded tier even with same accepted base',async()=>{
  const requestKey='req_'+randomUUID().replaceAll('-','');const r=await reserve('deepseek-v4-flash','fixture-v1:ds26:off_peak',requestKey);
  assert.equal((await reserve('deepseek-v4-flash','fixture-v1:ds26:off_peak',requestKey)).fresh,false);
  await assert.rejects(reserve('deepseek-v4-flash','fixture-v1:ds26:peak',requestKey));
  await db.query("update apiwild_finance.gateway_requests set state='cancelled' where id=$1",[r.record.id]);
 });
 await check('provider base version changes and revocation still prevent claim',async()=>{
  const r=await reserve('deepseek-v4-flash','fixture-v1:ds26:peak');
  await db.query("update apiwild_finance.provider_budgets set rate_version='fixture-v2' where id=$1",[budget]);
  await assert.rejects(db.query('select apiwild_gateway_claim($1,$2,$3)',[owner,r.record.id,r.record.version]));
  await db.query("update apiwild_finance.provider_budgets set rate_version='fixture-v1',accepted=false where id=$1",[budget]);
  await assert.rejects(db.query('select apiwild_gateway_claim($1,$2,$3)',[owner,r.record.id,r.record.version]));
 });
 await check('recovery returns only immutable quote and never creates a request',async()=>{
  const before=(await db.query('select count(*) n from apiwild_finance.gateway_requests')).rows[0].n;
  const row=(await db.query("select * from apiwild_finance.gateway_requests where model='deepseek-v4-flash' order by created_at limit 1")).rows[0];
  const lookup=async(patch={})=>{await db.exec('set role service_role');try{return (await db.query('select apiwild_gateway_quote_lookup($1,$2,$3,$4,$5,$6) r',
   [owner,patch.keyId??null,patch.requestKey??row.request_key,patch.hash??row.payload_hash,patch.capability??row.capability,patch.model??row.model])).rows[0].r;}finally{await db.exec('reset role');}};
  const result=await lookup();assert.equal(result.found,true);
  assert.deepEqual(Object.keys(result.quote).sort(),['model','providerBudgetId','rateVersion','reservedCnyMicros','reservedUsdMicros']);
  assert.equal(result.quote.rateVersion,row.rate_version);assert.equal((await lookup({requestKey:'missing_request_00001'})).found,false);
  for(const patch of [{hash:'b'.repeat(64)},{model:'deepseek-v4-pro'},{capability:'code'}])await assert.rejects(lookup(patch),/gateway_idempotency_conflict/);
  assert.equal((await db.query('select count(*) n from apiwild_finance.gateway_requests')).rows[0].n,before);
 });
 await check('recovery enforces exact owner and key scope, including revoked keys',async()=>{
  const other=randomUUID(),otherOwner='test:supabase:'+other,key=randomUUID();
  await db.query('insert into auth.users values($1,now(),false)',[other]);await db.query('select apiwild_gateway_account_initialize($1)',[otherOwner]);
  const row=(await db.query('select * from apiwild_finance.gateway_requests order by created_at limit 1')).rows[0];
  await db.query("insert into apiwild_finance.gateway_keys(id,user_id,hash,scopes) values($1,$2,$3,array['chat'])",[key,owner,'c'.repeat(64)]);
  const lookup=async(who,kid)=>{await db.exec('set role service_role');try{return (await db.query('select apiwild_gateway_quote_lookup($1,$2,$3,$4,$5,$6) r',[who,kid,row.request_key,row.payload_hash,row.capability,row.model])).rows[0].r;}finally{await db.exec('reset role');}};
  assert.deepEqual(await lookup(otherOwner,null),{found:false});
  await assert.rejects(lookup(owner,key),/gateway_idempotency_conflict/);
  await db.query('update apiwild_finance.gateway_keys set revoked_at=now() where id=$1',[key]);
  await assert.rejects(lookup(owner,key),/gateway_key_unavailable/);
  await assert.rejects(lookup(otherOwner,key),/gateway_key_unavailable/);
 });
 await check('helper is private and existing service RPC privilege remains unchanged',async()=>{
  const result=(await db.query("select has_function_privilege('anon','apiwild_finance.gateway_budget_rate_matches(text,text,text)','execute') a,has_function_privilege('service_role','apiwild_finance.gateway_budget_rate_matches(text,text,text)','execute') b,has_function_privilege('service_role','public.apiwild_gateway_claim(text,uuid,bigint)','execute') c")).rows[0];
  assert.deepEqual(result,{a:false,b:false,c:true});
  const lookup=(await db.query("select has_function_privilege('anon','public.apiwild_gateway_quote_lookup(text,uuid,text,text,text,text)','execute') a,has_function_privilege('authenticated','public.apiwild_gateway_quote_lookup(text,uuid,text,text,text,text)','execute') b,has_function_privilege('service_role','public.apiwild_gateway_quote_lookup(text,uuid,text,text,text,text)','execute') c")).rows[0];assert.deepEqual(lookup,{a:false,b:false,c:true});
  await assert.rejects(db.query('select apiwild_gateway_quote_lookup($1,null,$2,$3,$4,$5)',[owner,'request_fixture_0001','a'.repeat(64),'chat','deepseek-v4-flash']),/gateway_server_only/);
  const definitions=(await db.query("select n.nspname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('gateway_quote_lookup','apiwild_gateway_quote_lookup') order by n.nspname")).rows;
  assert.deepEqual(definitions,[{nspname:'apiwild_finance',prosecdef:true},{nspname:'public',prosecdef:false}]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[customer]);await db.exec('set role service_role');
  try{await assert.rejects(db.query('select apiwild_gateway_quote_lookup($1,null,$2,$3,$4,$5)',[owner,'request_fixture_0001','a'.repeat(64),'chat','deepseek-v4-flash']),/gateway_server_only/);}finally{await db.exec("reset role;select set_config('request.jwt.claim.sub','',false)");}
 });
 console.log('PASS '+count+' conditional tariff SQL checks.');
}finally{await db.close();}

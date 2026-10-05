// Local PostgreSQL semantics only. Explicit isolated pinned PGlite module path.
import {pathToFileURL,fileURLToPath} from 'node:url';import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {conversion,receiptNow} from './supplier-receipt-fixture.mjs';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);const db=new PGlite();const root=fileURLToPath(new URL('../../../',import.meta.url));let checks=0;
const customer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='test:supabase:'+customer,budget=randomUUID(),key=randomUUID();
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function call(name,args){await db.exec('set role service_role');try{return (await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') r',args)).rows[0].r;}finally{await db.exec('reset role');}}
async function request({state='succeeded',supplierPending=true,correlation=randomUUID(),reserve=800}={}){const id=randomUUID();await db.query(`insert into apiwild_finance.gateway_requests(id,user_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,settlement_reference,result_json,usage_json,expires_at,supplier_pending)
 values($1,$2,$3,$4,$5,'chat','model','v1',$6,100,$7,$8,$9,$10,now()+interval '1 hour',$11)`,[id,owner,budget,'request_'+id.replaceAll('-',''),'a'.repeat(64),state,reserve,'usage:'+correlation,{text:'private customer output'},{providerRequestId:correlation,providerCompletionId:'private_completion',private:'never exposed'},supplierPending]);return {id,correlation};}
const native=()=>({quota:4,quota_unit_currency:'USD',quota_per_unit:500000,price:'6.8',usd_exchange_rate:'6.8',quota_display_type:'CNY',display_in_currency:true,
 settings_observed_at:conversion.observedAt,settings_valid_until:conversion.validUntil,settings_sha256:conversion.settingsSha256,log_id:573,log_created_at:Math.floor(receiptNow/1000),account_user_id:21872,token_id:123,provider_slug:'leapnode',billing_source:'wallet',billing_multiplier:1});
const fact=r=>({receipt_id:'receipt_'+r.id,key_reference:key,upstream_response_id:r.correlation,model:'model',currency:'CNY',cost_cny_micros:55,native_debit:native()});
const apply=(r,f=fact(r))=>call('apiwild_supplier_debit_apply',[owner,r.id,f,'a'.repeat(64)]);
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);
 create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
 for(const file of ['20261003060000_apiwild_gateway_portability.sql','20261005010000_apiwild_stripe_projection.sql','20261005030000_retail_supplier_separation.sql','20261005083727_supplier_allowance_outbox.sql','20261005103212_supplier_receipt_reader.sql','20261005104158_supplier_pending_list.sql','20261005121900_bangai_request_identity.sql'])await db.exec(fs.readFileSync(root+'supabase/migrations/'+file,'utf8'));
 await db.query('insert into auth.users values($1,now(),false)',[customer]);await db.query('select public.apiwild_gateway_account_initialize($1)',[owner]);
 await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','test','CNY',$2,true,10000,10000,'v1',array['model'])",[budget,key]);
 await check('guarded request read returns exact identity only, never content; wrong owner and unfinished remain null',async()=>{
  const r=await request();assert.deepEqual(await call('apiwild_supplier_request_read',[owner,r.id]),{owner,requestId:r.id,keyReference:key,model:'model',upstreamResponseId:r.correlation,supplierPending:true});
  assert.equal(await call('apiwild_supplier_request_read',['test:supabase:'+randomUUID(),r.id]),null);
  for(const state of ['reserved','executing','uncertain','cancelled'])assert.equal(await call('apiwild_supplier_request_read',[owner,(await request({state})).id]),null);
  assert.equal(await call('apiwild_supplier_request_read',[owner,(await request({correlation:'legacy_completion'})).id]),null);
  assert.equal(await call('apiwild_supplier_request_read',[owner,(await request({supplierPending:false})).id]),null);
  await assert.rejects(call('apiwild_supplier_request_read',[owner+':extra',r.id]));
 });
 await check('read RPC is server-only and rejects customer JWT even under service role',async()=>{
  const r=await request();for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_supplier_request_read($1,$2)',[owner,r.id]));await db.exec('reset role');}
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[customer]);await assert.rejects(call('apiwild_supplier_request_read',[owner,r.id]));await db.query("select set_config('request.jwt.claim.sub','',false)");
  await db.exec('set role service_role');await assert.rejects(db.query('select * from apiwild_finance.gateway_requests'));await db.exec('reset role');
 });
 await check('database independently verifies exact USD-quota ceiling, stores audit, and replay never debits twice',async()=>{
  const r=await request();assert.equal((await apply(r)).reconciled,true);assert.equal((await apply(r)).replayed,true);
  const saved=(await db.query('select fact from apiwild_finance.supplier_debit_receipts where request_id=$1',[r.id])).rows[0].fact;assert.deepEqual(saved,fact(r));
  assert.equal((await db.query('select cost_cny_micros from apiwild_finance.gateway_requests where id=$1',[r.id])).rows[0].cost_cny_micros,55);
  assert.equal(await call('apiwild_supplier_request_read',[owner,r.id]),null);
  await assert.rejects(apply(r,{...fact(r),cost_cny_micros:54}));
 });
 await check('false normalized amount, currency, digest, audit types, unknown fields and missing binding fail without hold release',async()=>{
  const r=await request();const f=fact(r);
  for(const patch of [{quota:3},{quota:'4'},{quota:-1},{quota_unit_currency:'CNY'},{quota_per_unit:1000000},{price:'6.9'},{settings_sha256:'f'.repeat(64)},
   {provider_slug:null},{billing_source:'subscription'},{billing_multiplier:2},{settings_observed_at:null},{log_created_at:1},{extra:true}])await assert.rejects(apply(r,{...f,native_debit:{...f.native_debit,...patch}}));
  await assert.rejects(apply(r,{...f,native_debit:null}));await assert.rejects(apply(r,{...f,cost_cny_micros:54}));
  const noBinding=await request({correlation:'legacy_completion'});await db.query("update apiwild_finance.gateway_requests set usage_json='{}' where id=$1",[noBinding.id]);await assert.rejects(apply(noBinding));
  assert.equal((await db.query('select supplier_pending from apiwild_finance.gateway_requests where id=$1',[r.id])).rows[0].supplier_pending,true);
 });
 await check('legacy exact-CNY fact remains compatible and foreign or reused receipt cannot be substituted',async()=>{
  const r=await request(),f=fact(r);delete f.native_debit;assert.equal((await apply(r,f)).reconciled,true);
  const other=await request();await assert.rejects(apply(other,{...fact(other),receipt_id:f.receipt_id}));await assert.rejects(apply(other,{...fact(other),key_reference:randomUUID()}));
 });
 await check('four short bangai IDs require the recorded pair and native audit; replay stays exactly once',async()=>{
  const pendingIds=async()=>{let cursor=null;const ids=[];for(let page=0;page<20;page++){
   const rows=await call('apiwild_supplier_pending_list',['test',[key],cursor?.createdAt??null,cursor?.requestId??null]);assert.ok(rows.length<=5);ids.push(...rows.map(row=>row.requestId));if(rows.length<5)return ids;cursor=rows.at(-1);
  }assert.fail('Finite fixture scan did not complete');};
  const pairs=[['claude-opus-4-6','c2ea8134'],['claude-opus-4-7','b9b162d7'],['gpt-6-astra','afda6e04'],['gpt-6-sol','df8fae53']];
  for(const [model,correlation]of pairs){
   const r=await request({correlation});await db.query("update apiwild_finance.gateway_requests set model=$2,usage_json=usage_json||'{\"supplierSlug\":\"bangai\"}'::jsonb where id=$1",[r.id,model]);
   const read=await call('apiwild_supplier_request_read',[owner,r.id]);assert.equal(read.upstreamResponseId,correlation);assert.equal(read.model,model);
   assert.ok((await pendingIds()).includes(r.id));assert.deepEqual(await call('apiwild_supplier_pending_list',['live',[key],null,null]),[]);assert.deepEqual(await call('apiwild_supplier_pending_list',['test',[randomUUID()],null,null]),[]);
   const f={...fact(r),model,native_debit:{...native(),provider_slug:'bangai'}};
   const noAudit={...f};delete noAudit.native_debit;await assert.rejects(apply(r,noAudit));await assert.rejects(apply(r,{...f,native_debit:{...f.native_debit,provider_slug:'other'}}));
   assert.equal((await apply(r,f)).reconciled,true);assert.equal((await apply(r,f)).replayed,true);
   assert.equal((await pendingIds()).includes(r.id),false);
  }
  for(const patch of [{model:'model',supplierSlug:'bangai'},{model:'claude-opus-4-6',supplierSlug:'other'},{model:'claude-opus-4-6',supplierSlug:null}]){
   const r=await request({correlation:'c2ea8134'});await db.query('update apiwild_finance.gateway_requests set model=$2,usage_json=usage_json||jsonb_build_object(\'supplierSlug\',$3::text) where id=$1',[r.id,patch.model,patch.supplierSlug]);
   assert.equal(await call('apiwild_supplier_request_read',[owner,r.id]),null);assert.equal((await pendingIds()).includes(r.id),false);await assert.rejects(apply(r,{...fact(r),model:patch.model,native_debit:{...native(),provider_slug:'bangai'}}));
   assert.equal((await db.query('select supplier_pending from apiwild_finance.gateway_requests where id=$1',[r.id])).rows[0].supplier_pending,true);
  }
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_supplier_pending_list($1,$2,null,null)',['test',[key]]));await db.exec('reset role');}
 });
 await check('one shared budget permits 39 models, rejects 40/null, and monetary cap stays unchanged',async()=>{
  const models=Array.from({length:39},(_,i)=>'model_'+i);await db.query('update apiwild_finance.provider_budgets set models=$2 where id=$1',[budget,models]);
  await assert.rejects(db.query('update apiwild_finance.provider_budgets set models=$2 where id=$1',[budget,[...models,'forty']]));
  await assert.rejects(db.query('update apiwild_finance.provider_budgets set models=$2 where id=$1',[budget,['model',null]]));
  await assert.rejects(db.query('update apiwild_finance.provider_budgets set total_limit_cny_micros=50000001 where id=$1',[budget]));
 });
 await check('actual cost exceeding reservation holds and freezes supplier budget',async()=>{const r=await request({reserve:54});assert.equal((await apply(r)).reconciled,false);assert.equal((await db.query('select supplier_pending from apiwild_finance.gateway_requests where id=$1',[r.id])).rows[0].supplier_pending,true);assert.equal((await db.query('select accepted from apiwild_finance.provider_budgets where id=$1',[budget])).rows[0].accepted,false);});
 console.log('PASS '+checks+' isolated PostgreSQL checks. No external database or provider call.');
}catch(error){console.error('FAIL',error.message,error.code??'',error.position??'',error.where??'');process.exitCode=1;}finally{await db.close();}

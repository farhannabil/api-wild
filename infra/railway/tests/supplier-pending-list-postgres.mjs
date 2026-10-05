import {pathToFileURL,fileURLToPath} from 'node:url';import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);const db=new PGlite();const root=fileURLToPath(new URL('../../../',import.meta.url));let checks=0;
const customer=randomUUID(),owner='test:supabase:'+customer,budget=randomUUID(),key=randomUUID();
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function call(mode='test',keys=[key],cursor=null){await db.exec('set role service_role');try{return (await db.query('select public.apiwild_supplier_pending_list($1,$2,$3,$4) r',[mode,keys,cursor?.createdAt??null,cursor?.requestId??null])).rows[0].r;}finally{await db.exec('reset role');}}
async function row(patch={}){const id=randomUUID(),correlation=randomUUID();await db.query(`insert into apiwild_finance.gateway_requests(id,user_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,settlement_reference,usage_json,expires_at,supplier_pending,created_at)
 values($1,$2,$3,$4,$5,'chat','model','v1',$6,100,800,$7,$8,now()+interval '1 hour',$9,$10)`,[id,owner,budget,'request_'+id.replaceAll('-',''),'a'.repeat(64),patch.state??'succeeded',patch.mismatch?'usage:other':'usage:'+correlation,{providerRequestId:patch.legacy?'legacy_completion':correlation},patch.pending??true,patch.old?'2000-01-01T00:00:00Z':new Date().toISOString()]);return id;}
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
 for(const file of ['20261003060000_apiwild_gateway_portability.sql','20261005010000_apiwild_stripe_projection.sql','20261005030000_retail_supplier_separation.sql','20261005083727_supplier_allowance_outbox.sql','20261005103212_supplier_receipt_reader.sql','20261005104158_supplier_pending_list.sql'])await db.exec(fs.readFileSync(root+'supabase/migrations/'+file,'utf8'));
 await db.query('insert into auth.users values($1,now(),false)',[customer]);await db.query('select public.apiwild_gateway_account_initialize($1)',[owner]);await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','test','CNY',$2,true,10000,10000,'v1',array['model'])",[budget,key]);
 const eligible=[];for(let i=0;i<7;i++)eligible.push(await row());
 for(const patch of [{state:'executing'},{state:'uncertain'},{state:'reserved'},{pending:false},{old:true},{mismatch:true},{legacy:true}])await row(patch);
 await check('scan emits only final pending exact-correlated current-day rows, five then two, without mutations',async()=>{
  const first=await call();assert.equal(first.length,5);assert.ok(first.every(x=>Object.keys(x).sort().join(',')==='createdAt,owner,requestId'&&x.owner===owner));
  const next=await call('test',[key],first.at(-1));assert.equal(next.length,2);assert.deepEqual([...first,...next].map(x=>x.requestId).sort(),eligible.sort());assert.deepEqual(await call('test',[key],next.at(-1)),[]);
  assert.deepEqual(await call(),first);assert.equal((await db.query('select count(*)::int n from apiwild_finance.gateway_requests')).rows[0].n,14);
 });
 await check('wrong mode/key cannot enumerate another budget and malformed parameters fail closed',async()=>{
  assert.deepEqual(await call('live'),[]);assert.deepEqual(await call('test',[randomUUID()]),[]);await assert.rejects(call('other'));await assert.rejects(call('test',[]));await assert.rejects(call('test',[null]));await assert.rejects(call('test',[key],{requestId:randomUUID()}));
 });
 await check('list RPC remains service-only, with no customer JWT privilege escalation',async()=>{
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_supplier_pending_list($1,$2,null,null)',['test',[key]]));await db.exec('reset role');}
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[customer]);await assert.rejects(call());await db.query("select set_config('request.jwt.claim.sub','',false)");
 });
 console.log('PASS '+checks+' isolated PostgreSQL list checks.');
}catch(error){console.error('FAIL',error.message,error.code??'',error.position??'');process.exitCode=1;}finally{await db.close();}

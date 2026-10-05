// Local isolated PostgreSQL only. No environment secrets or remote queries.
import {pathToFileURL,fileURLToPath} from 'node:url';import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();
const root=fileURLToPath(new URL('../../../',import.meta.url));let count=0;
const check=async(name,fn)=>{await fn();console.log('PASS '+name);count++;};
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
  create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);
  create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
 for(const file of ['20261003060000_apiwild_gateway_portability.sql','20261005030000_retail_supplier_separation.sql'])await db.exec(fs.readFileSync(root+'supabase/migrations/'+file,'utf8'));
 const customer=randomUUID(),owner='test:supabase:'+customer,budget=randomUUID();
 await db.query('insert into auth.users values($1,now(),false)',[customer]);await db.query('select apiwild_gateway_account_initialize($1)',[owner]);
 await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','test','CNY',$2,true,50000000,50000000,'fixture',array['fixture'])",[budget,randomUUID()]);
 const make=async(state='reserved',pending=false,expires='-1 minute')=>{
  const id=randomUUID();await db.query(`insert into apiwild_finance.gateway_requests(id,user_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,expires_at,supplier_pending)
   values($1,$2,$3,$4,$5,'chat','fixture','fixture',$6,1000,500,clock_timestamp()+$7::interval,$8)`,[id,owner,budget,'fixture_'+id.replaceAll('-',''),'a'.repeat(64),state,expires,pending]);return id;
 };
 const expire=async(id,version=0,who=owner)=>{await db.exec('set role service_role');try{return (await db.query('select apiwild_gateway_expire($1,$2,$3) r',[who,id,version])).rows[0].r;}finally{await db.exec('reset role');}};
 await check('expired never-dispatched reservation cancels exactly once and preserves zero costs',async()=>{
  const id=await make(),result=await expire(id);assert.equal(result.cancelled,true);assert.equal(result.record.state,'cancelled');assert.equal(result.record.version,1);
  assert.equal(result.record.cost_usd_micros,0);assert.equal(result.record.cost_cny_micros,0);assert.equal(result.record.supplier_pending,false);assert.equal((await expire(id)).cancelled,false);
 });
 await check('future expiry and stale version cannot cancel a reservation',async()=>{
  for(const [id,version] of [[await make('reserved',false,'1 minute'),0],[await make(),1]]){const result=await expire(id,version);assert.equal(result.cancelled,false);assert.equal(result.record.state,'reserved');assert.equal(result.record.version,0);}
 });
 await check('executing uncertain and settled supplier-pending work preserve every held field',async()=>{
  for(const [state,pending] of [['executing',false],['uncertain',false],['succeeded',true],['failed',true]]){
   const id=await make(state,pending),before=(await db.query('select to_jsonb(r) r from apiwild_finance.gateway_requests r where id=$1',[id])).rows[0].r;
   const result=await expire(id);assert.equal(result.cancelled,false);assert.deepEqual(result.record,before);
  }
 });
 await check('foreign owner and public roles cannot expire a request',async()=>{
  const id=await make();await assert.rejects(expire(id,0,'test:supabase:'+randomUUID()),/gateway_request_not_found/);
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);try{await assert.rejects(db.query('select apiwild_gateway_expire($1,$2,0)',[owner,id]),/permission denied/);}finally{await db.exec('reset role');}}
  assert.equal((await db.query('select state from apiwild_finance.gateway_requests where id=$1',[id])).rows[0].state,'reserved');
 });
 console.log('PASS '+count+' reservation expiry SQL checks.');
}finally{await db.close();}

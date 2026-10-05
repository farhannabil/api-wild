// Isolated PGlite semantics and state/CAS race cases, not independent-session concurrency.
import {pathToFileURL,fileURLToPath} from 'node:url';import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),db=new PGlite();const root=fileURLToPath(new URL('../../../',import.meta.url));let checks=0;
const customer=randomUUID(),owner='test:supabase:'+customer,liveOwner='live:supabase:'+customer,budget=randomUUID(),liveBudget=randomUUID(),key=randomUUID(),otherKey=randomUUID();
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
async function call(name,args){await db.exec('set role service_role');try{return(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') r',args)).rows[0].r;}finally{await db.exec('reset role');}}
const list=(mode='test',keys=[key],cursor=null)=>call('apiwild_reservation_expiry_list',[mode,keys,cursor?.expiresAt??null,cursor?.requestId??null]);
const expire=(id,version=0,who=owner)=>call('apiwild_gateway_expire',[who,id,version]);
const read=async id=>(await db.query('select to_jsonb(r) r from apiwild_finance.gateway_requests r where id=$1',[id])).rows[0].r;
async function make({state='reserved',pending=false,future=false,live=false}={}){
 const id=randomUUID();await db.query(`insert into apiwild_finance.gateway_requests(id,user_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,expires_at,supplier_pending)
 values($1,$2,$3,$4,$5,'chat','fixture','fixture',$6,100,100,clock_timestamp()+$7::interval,$8)`,[id,live?liveOwner:owner,live?liveBudget:budget,'fixture_'+id.replaceAll('-',''),'a'.repeat(64),state,future?'1 hour':'-1 hour',pending]);return id;
}
try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);
 create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
 for(const file of ['20261003060000_apiwild_gateway_portability.sql','20261005010000_apiwild_stripe_projection.sql','20261005030000_retail_supplier_separation.sql','20261005083727_supplier_allowance_outbox.sql','20261005121036_reservation_expiry_sweep.sql'])await db.exec(fs.readFileSync(root+'supabase/migrations/'+file,'utf8'));
 await db.query('insert into auth.users values($1,now(),false)',[customer]);await db.query('select public.apiwild_gateway_account_initialize($1)',[owner]);await db.query('select public.apiwild_gateway_account_initialize($1)',[liveOwner]);
 for(const[id,mode,keyRef]of[[budget,'test',key],[liveBudget,'live',otherKey]])await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild',$2,'CNY',$3,true,50000000,50000000,'fixture',array['fixture'])",[id,mode,keyRef]);
 await check('list is mode/key scoped, bounded5, cursor paginates7 and readonly',async()=>{
  const ids=[];for(let i=0;i<7;i++)ids.push(await make());await make({live:true});await make({future:true});
  const first=await list();assert.equal(first.length,5);assert.ok(first.every(r=>ids.includes(r.requestId)&&r.owner===owner&&r.version===0));assert.deepEqual(Object.keys(first[0]).sort(),['expiresAt','owner','requestId','version']);
  const second=await list('test',[key],first.at(-1));assert.equal(second.length,2);assert.equal(new Set([...first,...second].map(r=>r.requestId)).size,7);assert.equal((await list('test',[otherKey])).length,0);assert.equal((await list('live',[otherKey])).length,1);assert.equal((await read(ids[0])).state,'reserved');
  await db.exec('delete from apiwild_finance.gateway_requests');
 });
 await check('only pristine expired never-dispatched work is listed/cancelled exactly once',async()=>{
  const safe=await make();const unsafe=[];
  for(const[state,pending]of[['reserved',true],['executing',false],['uncertain',false],['succeeded',true],['failed',true],['cancelled',false]])unsafe.push(await make({state,pending}));
  for(const[field,value]of[['cost_usd_micros',1],['cost_cny_micros',1],['observed_cny_micros',1],['pricing_bound_exceeded',true],['settlement_reference','usage:fixture'],['result_json',{text:'private'}],['usage_json',{providerRequestId:randomUUID()}]]){const id=await make();await db.query('update apiwild_finance.gateway_requests set '+field+'=$2 where id=$1',[id,value]);unsafe.push(id);}
  assert.deepEqual((await list()).map(r=>r.requestId),[safe]);
  for(const id of unsafe){const before=await read(id);assert.equal((await expire(id)).cancelled,false);assert.deepEqual(await read(id),before);}
  const result=await expire(safe);assert.equal(result.cancelled,true);assert.equal(result.record.state,'cancelled');assert.equal(result.record.version,1);assert.equal(result.record.cost_usd_micros,0);assert.equal(result.record.cost_cny_micros,0);assert.equal((await expire(safe)).cancelled,false);
  await db.exec('delete from apiwild_finance.gateway_requests');
 });
 await check('scan-to-claim/supplier-evidence/version/expiry races are rechecked atomically',async()=>{
  for(const[field,value]of[['state','executing'],['supplier_pending',true],['observed_cny_micros',1],['usage_json',{providerRequestId:randomUUID()}],['version',1]]){const id=await make();assert.ok((await list()).some(r=>r.requestId===id));await db.query('update apiwild_finance.gateway_requests set '+field+'=$2 where id=$1',[id,value]);const before=await read(id);assert.equal((await expire(id,0)).cancelled,false);assert.deepEqual(await read(id),before);}
  const future=await make({future:true});assert.equal((await expire(future)).cancelled,false);const stale=await make();assert.equal((await expire(stale,1)).cancelled,false);await db.exec('delete from apiwild_finance.gateway_requests');
 });
 await check('RPCs are server-only, reject customer JWT and invalid/broad scans, preserve finance',async()=>{
  const id=await make();for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_reservation_expiry_list($1,$2,null,null)',['test',[key]]));await assert.rejects(db.query('select public.apiwild_gateway_expire($1,$2,0)',[owner,id]));await db.exec('reset role');}
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[customer]);await assert.rejects(list());await assert.rejects(expire(id));await db.query("select set_config('request.jwt.claim.sub','',false)");
  for(const[mode,keys,cursor]of[['any',[key],null],['test',[],null],['test',[key,key],null],['test',[key,null],null],['test',[key,otherKey,randomUUID()],null],['test',[key],{expiresAt:null,requestId:id}]])await assert.rejects(list(mode,keys,cursor));
  await assert.rejects(expire(id,0,'test:supabase:'+randomUUID()));
  const before=(await db.query('select funded_usd_micros,payment_hold_usd_micros from apiwild_finance.gateway_accounts where user_id=$1',[owner])).rows[0];await expire(id);assert.deepEqual((await db.query('select funded_usd_micros,payment_hold_usd_micros from apiwild_finance.gateway_accounts where user_id=$1',[owner])).rows[0],before);
  assert.equal((await db.query('select count(*)::int n from apiwild_finance.gateway_outbox')).rows[0].n,0);
 });
 console.log('PASS '+checks+' isolated expiry sweep SQL groups. No external calls or independent-session concurrency claim.');
}catch(error){console.error('FAIL',error.message,error.code??'',error.position??'',error.where??'');process.exitCode=1;}finally{await db.close();}

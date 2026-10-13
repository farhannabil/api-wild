import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();let checks=0;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
async function call(name,args=[]){await db.exec('set role service_role');try{return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;}finally{await db.exec('reset role');}}
const owner='live:supabase:'+randomUUID(),other='live:supabase:'+randomUUID(),testOwner='test:supabase:'+randomUUID();
const funded=async own=>Number((await db.query('select funded_usd_micros n from apiwild_finance.gateway_accounts where user_id=$1',[own])).rows[0].n);
const queue=async()=>Number((await db.query('select count(*) n from apiwild_finance.credit_email_queue')).rows[0].n);
async function campaign(code,{amount=500,max=1,enabled=true,start=-3600,end=3600}={}){await db.query("insert into apiwild_finance.credit_codes(code,amount_cents,max_redemptions,starts_at,ends_at,enabled) values($1,$2,$3,clock_timestamp()+$4*interval '1 second',clock_timestamp()+$5*interval '1 second',$6)",[code,amount,max,start,end,enabled]);}
try{
 const baseline=fs.readFileSync(new URL('./supplier-cost-five-pglite.mjs',import.meta.url),'utf8');const names=[...baseline.matchAll(/'(2026[^']+\.sql)'/g)].map(x=>x[1]);
 assert.ok(names.includes('20261013010000_supplier_cost_five_times.sql'));
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to service_role;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false,email text);create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);");
 for(const name of [...names,'20261013020000_usage_analytics_jobs.sql','20261013040000_customer_credit_console.sql','20261013040100_usage_explorer.sql'])await db.exec(fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
 for(const [i,own]of [owner,other,testOwner].entries()){await db.query('insert into auth.users(id,email_confirmed_at,is_anonymous,email) values($1,now(),false,$2)',[own.split(':')[2],`fixture${i}@example.invalid`]);await call('apiwild_gateway_account_initialize',[own]);}
 await check('RPC permissions and private tables deny public/customer/direct service access',async()=>{
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_redeem_credit_code($1,$2)',[owner,'WELCOME']));await assert.rejects(db.query('select public.apiwild_credit_history($1)',[owner]));await assert.rejects(db.query('select public.apiwild_claim_credit_email()'));await assert.rejects(db.query('select public.apiwild_customer_key_names($1)',[owner]));await db.exec('reset role');}
  await db.exec('set role service_role');await assert.rejects(db.query('select * from apiwild_finance.credit_codes'));await assert.rejects(db.query('select apiwild_finance.queue_credit_email($1,$2,1,$3)',['forge',owner,'promo']));await db.exec('reset role');
 });
 await check('normalized promo grants once; retries preserve balance and one notification; global cap enforced',async()=>{
  await campaign('WELCOME');assert.deepEqual(await call('apiwild_redeem_credit_code',[owner,' welcome ']),{redeemed:true,replayed:false,amountCents:500});assert.equal(await funded(owner),5000000);assert.equal(await queue(),1);
  assert.deepEqual(await call('apiwild_redeem_credit_code',[owner,'WELCOME']),{redeemed:true,replayed:true,amountCents:500});assert.equal(await funded(owner),5000000);assert.equal(await queue(),1);
  assert.equal((await call('apiwild_redeem_credit_code',[other,'WELCOME'])).redeemed,false);assert.equal(await funded(other),0);assert.equal((await call('apiwild_credit_history',[owner])).length,1);assert.deepEqual(await call('apiwild_credit_history',[other]),[]);
  assert.equal((await db.query("select redeemed from apiwild_finance.credit_codes where code='WELCOME'")).rows[0].redeemed,1);
  assert.equal((await db.query("select enabled from apiwild_finance.credit_codes where code='WELCOME'")).rows[0].enabled,false,'exhausted one-use campaign must disable itself');
 });
 await check('expired, future, disabled, unknown, invalid and test-mode codes cannot grant funds',async()=>{
  await campaign('EXPIRED',{start:-7200,end:-3600});await campaign('FUTURE',{start:3600,end:7200});await campaign('DISABLED',{enabled:false});
  for(const code of ['EXPIRED','FUTURE','DISABLED','UNKNOWN','!','',null])assert.equal((await call('apiwild_redeem_credit_code',[other,code])).redeemed,false);
  await campaign('TESTONLY');assert.equal((await call('apiwild_redeem_credit_code',[testOwner,'TESTONLY'])).redeemed,false);assert.equal(await funded(other),0);assert.equal(await funded(testOwner),0);
  await db.exec("update apiwild_finance.credit_codes set enabled=false,ends_at=clock_timestamp()-interval '1 second' where code='WELCOME'");assert.equal((await call('apiwild_redeem_credit_code',[owner,'WELCOME'])).replayed,true);assert.equal(await funded(owner),5000000);
 });
 await check('card notification requires actual posted credit; checkout/pending/replay/refund do not duplicate',async()=>{
  const id=randomUUID(),compact=id.replaceAll('-',''),account='acct_1UCiHN194XZKj6cF',session='cs_live_'+compact;
  const intent=await call('apiwild_stripe_prepare_checkout',[id,owner,'live',account,'price_fixture',null,3000,null,null]);
  await call('apiwild_stripe_register_checkout',[id,owner,'live',account,session,'cus_fixture',intent.amount_cents]);assert.equal(await queue(),1);
  const fact={order_id:id,customer_id:'cus_fixture',currency:'usd',payment_intent:'pi_'+compact,session_id:session,subtotal_cents:3000,total_cents:3000,tax_cents:0,discount_cents:0,status:'complete',payment_status:'unpaid'};
  const project=(event,type,operation,f)=>call('apiwild_stripe_project',[account,'live',event,type,'a'.repeat(64),100,operation,f]);
  await project('evt_pending','checkout.session.completed','checkout',fact);assert.equal(await queue(),1);assert.equal(await funded(owner),5000000);
  const paid={...fact,payment_status:'paid'};await project('evt_paid','checkout.session.async_payment_succeeded','checkout',paid);assert.equal(await queue(),2);assert.equal(await funded(owner),35000000);
  assert.equal((await project('evt_paid','checkout.session.async_payment_succeeded','checkout',paid)).replayed,true);await project('evt_paidagain','checkout.session.completed','checkout',paid);assert.equal(await queue(),2);assert.equal(await funded(owner),35000000);
  const card=(await db.query("select * from apiwild_finance.credit_email_queue where source='card'")).rows[0];assert.equal(card.amount_cents,3000);assert.equal(card.owner,owner);assert.equal(card.recipient,'fixture0@example.invalid');
  await project('evt_refund','charge.refunded','refund',{order_id:id,customer_id:'cus_fixture',currency:'usd',payment_intent:'pi_'+compact,received_cents:3000,refunded_cents:3000});assert.equal(await queue(),2);assert.equal(await funded(owner),5000000);
 });
 await check('email lease fencing, retry backoff and sent completion are idempotent',async()=>{
  const first=await call('apiwild_claim_credit_email'),second=await call('apiwild_claim_credit_email');assert.ok(first.id&&first.leaseId);assert.notEqual(first.id,second.id);assert.equal(await call('apiwild_claim_credit_email'),null);
  assert.equal((await call('apiwild_finish_credit_email',[first.id,randomUUID(),'sent',randomUUID()])).finished,false);
  await assert.rejects(call('apiwild_finish_credit_email',[first.id,first.leaseId,'sent',null]),/invalid_email_outcome/);
  const provider=randomUUID();assert.equal((await call('apiwild_finish_credit_email',[first.id,first.leaseId,'sent',provider])).finished,true);assert.equal((await call('apiwild_finish_credit_email',[first.id,first.leaseId,'sent',provider])).finished,false);
  assert.equal((await call('apiwild_finish_credit_email',[second.id,second.leaseId,'retry',null])).finished,true);assert.equal(await call('apiwild_claim_credit_email'),null);
  await db.query("update apiwild_finance.credit_email_queue set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",[second.id]);const retry=await call('apiwild_claim_credit_email');assert.equal(retry.id,second.id);assert.notEqual(retry.leaseId,second.leaseId);
  assert.equal((await call('apiwild_finish_credit_email',[second.id,second.leaseId,'sent',randomUUID()])).finished,false);assert.equal((await call('apiwild_finish_credit_email',[retry.id,retry.leaseId,'failed',null])).finished,true);
 });
 await check('email claims stop after retry count or idempotency window',async()=>{
  await db.query("insert into apiwild_finance.credit_email_queue(event_key,owner,recipient,amount_cents,source,attempts,first_attempt_at) values('fixture:max',$1,'test@example.invalid',1,'promo',5,clock_timestamp()),('fixture:old',$1,'test@example.invalid',1,'promo',1,clock_timestamp()-interval '24 hours')",[owner]);
  assert.equal(await call('apiwild_claim_credit_email'),null);assert.equal(Number((await db.query("select count(*) n from apiwild_finance.credit_email_queue where event_key in ('fixture:max','fixture:old') and status='failed'")).rows[0].n),2);
 });
 await check('key names are owner-scoped, trim whitespace and reject malformed values',async()=>{
  const key=randomUUID();await call('apiwild_gateway_key_issue',[owner,key,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),['chat'],null,null,null]);
  assert.deepEqual(await call('apiwild_customer_key_names',[owner,key,'  Work laptop  ']),[{id:key,name:'Work laptop'}]);assert.deepEqual(await call('apiwild_customer_key_names',[other,null,null]),[]);
  await assert.rejects(call('apiwild_customer_key_names',[other,key,'Stolen']),/key_unavailable/);
  for(const name of ['',null,' '.repeat(4),'a'.repeat(65),'line\nbreak'])await assert.rejects(call('apiwild_customer_key_names',[owner,key,name]),/invalid_key_name/);
  assert.deepEqual(await call('apiwild_customer_key_names',[owner,null,null]),[{id:key,name:'Work laptop'}]);
 });
 await check('another worker cannot invalidate the final permitted active delivery lease',async()=>{
  await db.query("insert into apiwild_finance.credit_email_queue(event_key,owner,recipient,amount_cents,source,attempts,first_attempt_at) values('fixture:last-attempt',$1,'test@example.invalid',1,'promo',4,clock_timestamp())",[owner]);
  const job=await call('apiwild_claim_credit_email');assert.ok(job?.id);assert.equal(await call('apiwild_claim_credit_email'),null);
  assert.equal((await call('apiwild_finish_credit_email',[job.id,job.leaseId,'sent',randomUUID()])).finished,true,'fifth attempt lease was invalidated by another claim');
 });
 await check('usage explorer sums model tokens, scopes activity, hides private facts and excludes allowance holds',async()=>{
  const budget=randomUUID();await db.query("insert into apiwild_finance.provider_budgets values($1,'apiwild','live','CNY',$2,true,50000000,50000000,'v1',array['fixture-model'])",[budget,randomUUID()]);
  async function request(own,input,output,cost,options={}){const id=randomUUID();await db.query("insert into apiwild_finance.gateway_requests(id,user_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,cost_usd_micros,reserved_cny_micros,usage_json,result_json,settlement_reference,expires_at,created_at) values($1,$2,$3,$4,$5,'chat','fixture-model','v1',$6,1000,$7,1000,$8,$9,'private-settlement',clock_timestamp()+interval '1 hour',clock_timestamp()-$10*interval '1 day')",[id,own,budget,'fixture_'+id.replaceAll('-',''),'a'.repeat(64),options.state??'succeeded',cost,{prompt_tokens:input,completion_tokens:output,providerRequestId:'private-provider-id',supplierUsdMicros:42,privatePrompt:'never-display',...options.usage},{text:'private-model-output'},options.ageDays??0]);return id;}
  const first=await request(owner,10,2,100,{usage:{cache_read_tokens:0}}),second=await request(owner,20,3,200);
  await db.query('insert into apiwild_finance.usage_token_details(request_id,cache_read_tokens,cache_write_tokens) values($1,7,4)',[second]);
  const foreign=await request(other,999,888,700),hold=await request(owner,500,500,0,{state:'uncertain',usage:{nativeAllowance:true}}),old=await request(owner,888,888,500,{ageDays:31});
  await db.query('select apiwild_finance.refresh_usage_dashboard()');
  const own=await call('apiwild_usage_explorer',[owner]),theirs=await call('apiwild_usage_explorer',[other]);
  assert.equal(own.models.length,1);assert.deepEqual(own.models[0],{model:'fixture-model',requests:2,chargedUsdMicros:300,inputTokens:30,outputTokens:5,cacheReadTokens:7,cacheWriteTokens:4,cacheReadKnown:2,cacheWriteKnown:1});
  assert.deepEqual(new Set(own.activity.map(r=>r.id)),new Set([first,second]));assert.deepEqual(theirs.activity.map(r=>r.id),[foreign]);assert.equal(theirs.models[0].inputTokens,999);
  assert.ok(!own.activity.some(r=>[foreign,hold,old].includes(r.id)));assert.equal(own.activity.find(r=>r.id===first).cacheReadTokens,0);assert.equal(own.activity.find(r=>r.id===first).cacheWriteTokens,null);assert.equal(own.activity.find(r=>r.id===second).cacheWriteTokens,4);
  const allowed=['id','createdAt','model','state','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','chargedUsdMicros','pending'];for(const activity of own.activity)assert.deepEqual(Object.keys(activity).sort(),allowed.toSorted());
  const exposed=JSON.stringify(own);for(const secret of ['private-provider-id','never-display','private-model-output','private-settlement','supplierUsdMicros','provider_budget_id','usage_json'])assert.ok(!exposed.includes(secret),secret+' exposed');
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.apiwild_usage_explorer($1)',[owner]));await db.exec('reset role');}
  await assert.rejects(call('apiwild_usage_explorer',['live:supabase:'+randomUUID()]),/gateway_customer_unavailable/);
 });
 console.log('PASS '+checks+' customer credit console PostgreSQL checks. No external calls.');
}catch(e){console.error('FAIL',e.message,e.code??'',e.where??'');process.exitCode=1;}finally{await db.close();}

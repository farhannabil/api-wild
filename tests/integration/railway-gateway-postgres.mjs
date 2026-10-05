// Actual local PostgreSQL fixtures, not a production migration or seller test.
// node tests/integration/railway-gateway-postgres.mjs PORT /absolute/pg/lib/index.js
// Start a NEW loopback-only apiwild-outbox-pg-* cluster with fixed outbox_test.
// Never accepts DATABASE_URL, global environment credentials or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const port=Number(process.argv[2]);
if(!Number.isInteger(port)||port<1024||port>65535||!process.argv[3])throw new Error('Explicit isolated port and installed pg module required');
const {Client}=createRequire(import.meta.url)(process.argv[3]);
const options={host:'127.0.0.1',port,user:'outbox_test',database:'postgres',ssl:false,password:()=>'',connectionTimeoutMillis:5000,
  query_timeout:25000,options:'-c statement_timeout=20s -c lock_timeout=5s'};
const admin=new Client(options);await admin.connect();
const identity=(await admin.query("select current_setting('data_directory') as path,current_setting('server_version_num')::integer as version,current_user as owner")).rows[0];
assert.match(identity.path.replaceAll('\\','/'),/\/Temp\/apiwild-outbox-pg-[A-Za-z0-9]+$/);
assert.equal(identity.owner,'outbox_test');assert.equal(Math.floor(identity.version/10000),18);
const database='gateway_test_'+randomUUID().replaceAll('-','');
await admin.query(`create database ${database}`);await admin.end();
const db=new Client({...options,database});await db.connect();
const wallClock=setTimeout(()=>{console.error('Isolated gateway test wall-clock bound exceeded');process.exit(124);},120000);
wallClock.unref();
const migration=await readFile(new URL('../../supabase/migrations/20261003060000_apiwild_gateway_portability.sql',import.meta.url),'utf8');
const ids={customer:'12345678-1234-4123-8123-123456789abc',other:'22345678-1234-4123-8123-123456789abc',budget:'33333333-3333-4333-8333-333333333333',
  otherBudget:'43333333-3333-4333-8333-333333333333',key:'53333333-3333-4333-8333-333333333333',otherKey:'63333333-3333-4333-8333-333333333333'};
const owner='live:supabase:'+ids.customer,other='live:supabase:'+ids.other;
const rate='fixture-native-CNY-NOT-A-REAL-PRICE';
const hash='a'.repeat(64);
const reserveParams=overrides=>[owner,null,ids.budget,'request-fixture-00001',hash,'chat','fixture/chat',rate,800,2000].map((value,index)=>Object.hasOwn(overrides||{},index)?overrides[index]:value);
const reserveSql='select public.apiwild_gateway_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as value';
async function reserve(overrides={},client=db){return(await client.query(reserveSql,reserveParams(overrides))).rows[0].value;}
async function claim(record,client=db,who=owner,version=record.version){return(await client.query('select public.apiwild_gateway_claim($1,$2,$3) as value',[who,record.id,version])).rows[0].value;}
async function uncertain(record,client=db,who=owner,version=record.version){return(await client.query('select public.apiwild_gateway_uncertain($1,$2,$3) as value',[who,record.id,version])).rows[0].value;}
async function expire(record,client=db,who=owner,version=record.version){return(await client.query('select public.apiwild_gateway_expire($1,$2,$3) as value',[who,record.id,version])).rows[0].value;}
// This SYNTHETIC text is NOT independently verified provider billing evidence.
const finishParams=(record,changes={})=>[owner,record.id,record.version,'succeeded',100,1000,'SYNTHETIC-LOCAL-FIXTURE-NOT-SELLER-VERIFICATION',
  {text:'offline fixture answer'},{inputTokens:1,outputTokens:1}].map((value,index)=>{
    const selected=Object.hasOwn(changes,index)?changes[index]:value;
    // pg otherwise serializes JS arrays as SQL arrays, e.g. [] becomes "{}".
    // Encode JSONB parameters explicitly so the fixture exercises actual JSON.
    return index>=7&&selected!==null?JSON.stringify(selected):selected;
  });
async function finish(record,changes={},client=db){return(await client.query('select public.apiwild_gateway_finish($1,$2,$3,$4,$5,$6,$7,$8,$9) as value',finishParams(record,changes))).rows[0].value;}
async function row(id){return(await db.query('select * from apiwild_finance.gateway_requests where id=$1',[id])).rows[0];}
async function count(table){return Number((await db.query(`select count(*) as n from apiwild_finance.${table}`)).rows[0].n);}
async function reset({funded=1000,provider=50000000,daily=1000000000,keyDaily=1000000000,keyTotal=1000000000,accepted=true}={}){
  await db.query('truncate apiwild_finance.gateway_outbox,apiwild_finance.gateway_requests,apiwild_finance.gateway_keys,apiwild_finance.gateway_accounts,apiwild_finance.provider_budgets');
  await db.query('update auth.users set email_confirmed_at=now(),is_anonymous=false');
  await db.query('update public.customer_profiles set onboarding_completed_at=now()');
  for(const [user,customer] of [[owner,ids.customer],[other,ids.other]])await db.query(
    "insert into apiwild_finance.gateway_accounts(user_id,customer_id,billing_mode,funded_usd_micros,daily_limit_usd_micros) values($1,$2,'live',$3,$4)",[user,customer,funded,daily]);
  await db.query("insert into apiwild_finance.provider_budgets(id,product,billing_mode,key_reference,accepted,total_limit_cny_micros,daily_limit_cny_micros,rate_version,models) values($1,'apiwild','live',$2,$3,$4,$4,$5,array['fixture/chat'])",
    [ids.budget,randomUUID(),accepted,provider,rate]);
  for(const [id,user,h] of [[ids.key,owner,hash],[ids.otherKey,other,'b'.repeat(64)]])await db.query(
    "insert into apiwild_finance.gateway_keys(id,user_id,hash,scopes,daily_limit_usd_micros,total_limit_usd_micros,expires_at) values($1,$2,$3,array['chat'],$4,$5,now()+interval '1 hour')",[id,user,h,keyDaily,keyTotal]);
}
async function parallel(count,task){
  const clients=Array.from({length:count},()=>new Client({...options,database}));
  try{await Promise.all(clients.map(client=>client.connect()));return await Promise.allSettled(clients.map((client,index)=>task(client,index)));}
  finally{await Promise.all(clients.map(client=>client.end()));}
}
try{
  await db.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $$;
    create schema auth;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean not null default false);
    create table public.customer_profiles(user_id uuid primary key references auth.users(id),onboarding_completed_at timestamptz);
    insert into auth.users(id,email_confirmed_at) values('${ids.customer}',now()),('${ids.other}',now());
    insert into public.customer_profiles select id,now() from auth.users;`);
  await test('migration compiles/reapplies on PG18 and seeds no accounts, budgets or keys',async()=>{
    await db.query(migration);await db.query(migration);
    for(const table of ['gateway_accounts','provider_budgets','gateway_keys','gateway_requests','gateway_outbox'])assert.equal(await count(table),0);
    assert.equal((await db.query("select count(*)::integer as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='apiwild_finance' and c.relkind='r' and c.relrowsecurity")).rows[0].n,5);
    const functions=(await db.query("select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like 'apiwild_gateway_%'")).rows;
    assert.equal(functions.length,5);
    for(const fn of functions){assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.includes('search_path=""'));assert.ok(fn.proconfig.includes('lock_timeout=5s'));assert.ok(fn.proconfig.includes('statement_timeout=20s'));}
  });
  await test('all customer roles denied all RPCs and private tables; service role only gets RPCs',async()=>{
    await reset();const reserved=await reserve();
    for(const role of ['anon','authenticated']){
      await db.query(`set role ${role}`);
      try{for(const sql of [reserveSql,'select public.apiwild_gateway_claim($1,$2,$3)','select public.apiwild_gateway_uncertain($1,$2,$3)','select public.apiwild_gateway_expire($1,$2,$3)','select public.apiwild_gateway_finish($1,$2,$3,$4,$5,$6,$7,$8,$9)']){
        const args=sql===reserveSql?reserveParams():sql.includes('finish')?finishParams(reserved.record):[owner,reserved.record.id,0];
        await assert.rejects(db.query(sql,args),e=>e.code==='42501');
      }await assert.rejects(db.query('select * from apiwild_finance.gateway_accounts'),e=>e.code==='42501');}finally{await db.query('reset role');}
    }
    await db.query('set role service_role');
    try{assert.equal((await reserve()).fresh,false);assert.equal((await claim(reserved.record)).claimed,true);await assert.rejects(db.query('select * from apiwild_finance.gateway_requests'),e=>e.code==='42501');}
    finally{await db.query('reset role');}
  });
  await test('accepted=false default and unverified model/rate/mode cannot reserve',async()=>{
    await reset({accepted:false});await assert.rejects(reserve(),/gateway_provider_unavailable/);
    await db.query('alter table apiwild_finance.provider_budgets alter column accepted set default false');
    await reset();for(const changes of [{6:'arbitrary/model'},{7:'invented-price'}])await assert.rejects(reserve(changes),/gateway_provider_unavailable/);
    await db.query("update apiwild_finance.provider_budgets set billing_mode='test'");await assert.rejects(reserve(),/gateway_provider_unavailable/);
    assert.equal(await count('gateway_requests'),0);
  });
  await test('null/negative/oversized/fractional reservation inputs create no holds',async()=>{
    await reset();for(const index of [0,2,3,4,5,6,7,8,9])await assert.rejects(reserve({[index]:null}),/gateway_invalid_reservation/);
    for(const changes of [{3:'short'},{4:'bad'},{5:'nope'},{8:0},{8:-1},{8:'1000000000001'},{9:0},{9:50000001}])await assert.rejects(reserve(changes),/gateway_invalid_reservation/);
    await assert.rejects(reserve({8:'1.5'}),e=>e.code==='22P02');assert.equal(await count('gateway_requests'),0);
  });
  await test('unconfirmed, anonymous, incomplete and suspended identities stay blocked',async()=>{
    for(const update of ["update auth.users set email_confirmed_at=null where id=$1","update auth.users set is_anonymous=true where id=$1","update customer_profiles set onboarding_completed_at=null where user_id=$1"]){
      await reset();await db.query(update,[ids.customer]);await assert.rejects(reserve(),/gateway_customer_unavailable/);
    }await reset();await db.query('update apiwild_finance.gateway_accounts set suspended=true where user_id=$1',[owner]);await assert.rejects(reserve(),/gateway_customer_unavailable/);
  });
  await test('32 real PG connections cannot overdraw one customer balance',async()=>{
    await reset();const result=await parallel(32,(client,index)=>reserve({3:'request-contention-'+String(index).padStart(3,'0')},client));
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(await count('gateway_requests'),1);
    assert.equal(Number((await db.query('select sum(reserved_usd_micros) as n from apiwild_finance.gateway_requests')).rows[0].n),800);
    for(const rejected of result.filter(x=>x.status==='rejected'))assert.match(rejected.reason.message,/gateway_customer_limit/);
  });
  await test('pre-established REPEATABLE READ snapshots fail closed for all RPCs',async()=>{
    await reset();const executing=(await claim((await reserve()).record)).record;
    const results=await parallel(2,async(client,index)=>{
      await client.query('begin isolation level repeatable read');
      try{
        await client.query('select count(*) from apiwild_finance.gateway_requests');
        const operation=index?()=>reserve({0:other,3:'request-repeatable-read-two'},client):()=>reserve({3:'request-repeatable-read-one'},client);
        await assert.rejects(operation(),/gateway_isolation_unsupported/);
      }finally{await client.query('rollback');}
      for(const operation of [()=>claim(executing,client),()=>finish(executing,{},client),()=>uncertain(executing,client),()=>expire(executing,client)]){
        await client.query('begin isolation level repeatable read');
        try{await client.query('select count(*) from apiwild_finance.gateway_requests');await assert.rejects(operation(),/gateway_isolation_unsupported/);}
        finally{await client.query('rollback');}
      }return true;
    });
    assert.equal(results.filter(x=>x.status==='fulfilled').length,2);assert.equal(await count('gateway_requests'),1);assert.equal((await row(executing.id)).state,'executing');
  });
  await test('concurrent duplicates reserve once and competing claims dispatch once',async()=>{
    await reset();const results=await parallel(8,client=>reserve({},client));assert.equal(results.filter(x=>x.status==='fulfilled').length,8);
    const reservations=results.map(x=>x.value);assert.equal(reservations.filter(x=>x.fresh).length,1);assert.equal(new Set(reservations.map(x=>x.record.id)).size,1);
    const claims=await parallel(2,client=>claim(reservations[0].record,client));assert.equal(claims.filter(x=>x.status==='fulfilled'&&x.value.claimed).length,1);
    assert.equal((await row(reservations[0].record.id)).state,'executing');assert.equal(await count('gateway_outbox'),0);
  });
  await test('payload/key/budget mismatch rejects replay without leaking another owner',async()=>{
    await reset();const {record}=await reserve();for(const changes of [{4:'b'.repeat(64)},{1:ids.key},{8:801},{9:2001}])await assert.rejects(reserve(changes),/gateway_idempotency_conflict/);
    for(const operation of [()=>claim(record,db,other),()=>uncertain(record,db,other),()=>finish(record,{0:other})])await assert.rejects(operation(),/gateway_request_not_found/);
    await assert.rejects(reserve({1:ids.otherKey}),/gateway_key_unavailable/);assert.equal(await count('gateway_requests'),1);
  });
  await test('key scopes, expiry, revocation and per-key total/daily caps are enforced',async()=>{
    for(const update of ["update apiwild_finance.gateway_keys set scopes=array['code'] where id=$1","update apiwild_finance.gateway_keys set expires_at=now()-interval '1 second' where id=$1","update apiwild_finance.gateway_keys set revoked_at=now() where id=$1"]){
      await reset();await db.query(update,[ids.key]);await assert.rejects(reserve({1:ids.key}),/gateway_key_unavailable/);
    }for(const limits of [{keyTotal:700},{keyDaily:700}]){await reset(limits);await assert.rejects(reserve({1:ids.key}),/gateway_key_limit/);}
    await reset({funded:2000,keyTotal:1000});await reserve({1:ids.key});await assert.rejects(reserve({1:ids.key,3:'request-key-second-001',8:300}),/gateway_key_limit/);
  });
  await test('CNY50 total is literal native currency, not a USD conversion; globally serialized across owners',async()=>{
    await reset({funded:1000000});const results=await parallel(8,(client,index)=>reserve({0:index%2?other:owner,3:'request-supplier-cap-'+index,8:1,9:30000000},client));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);for(const item of results.filter(x=>x.status==='rejected'))assert.match(item.reason.message,/gateway_provider_limit/);
    assert.equal(Number((await db.query('select sum(reserved_cny_micros) as n from apiwild_finance.gateway_requests')).rows[0].n),30000000);
    await assert.rejects(db.query('update apiwild_finance.provider_budgets set total_limit_cny_micros=50000001'),e=>e.code==='23514');
    await assert.rejects(db.query("update apiwild_finance.provider_budgets set currency='USD'"),e=>e.code==='23514');
  });
  await test('different supplier rows still serialize the same customer wallet',async()=>{
    await reset();await db.query("insert into apiwild_finance.provider_budgets select $1,product,billing_mode,currency,$2,accepted,total_limit_cny_micros,daily_limit_cny_micros,rate_version,models from apiwild_finance.provider_budgets where id=$3",[ids.otherBudget,randomUUID(),ids.budget]);
    const results=await parallel(2,(client,index)=>reserve({2:index?ids.otherBudget:ids.budget,3:'request-two-budgets-'+index},client));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(await count('gateway_requests'),1);
  });
  await test('customer daily/payment-hold/concurrency limits remain finite',async()=>{
    await reset({daily:700});await assert.rejects(reserve(),/gateway_customer_limit/);
    await reset();await db.query('update apiwild_finance.gateway_accounts set payment_hold_usd_micros=300 where user_id=$1',[owner]);await assert.rejects(reserve(),/gateway_customer_limit/);
    await reset({funded:10000});await reserve({8:1});await reserve({3:'request-concurrency-002',8:1});await assert.rejects(reserve({3:'request-concurrency-003',8:1}),/gateway_customer_limit/);
  });
  await test('claims recheck expired keys, changed caps, refund projections and supplier disable',async()=>{
    for(const [sql,args,message] of [
      ['update apiwild_finance.gateway_keys set revoked_at=now() where id=$1',[ids.key],'gateway_key_unavailable'],
      ['update apiwild_finance.gateway_keys set total_limit_usd_micros=100 where id=$1',[ids.key],'gateway_key_limit'],
      ['update apiwild_finance.gateway_accounts set funded_usd_micros=0 where user_id=$1',[owner],'gateway_customer_limit'],
      ['update apiwild_finance.provider_budgets set accepted=false where id=$1',[ids.budget],'gateway_provider_unavailable'],
      ['update apiwild_finance.provider_budgets set total_limit_cny_micros=1 where id=$1',[ids.budget],'gateway_provider_limit']]){
      await reset();const {record}=await reserve({1:ids.key});await db.query(sql,args);await assert.rejects(claim(record),new RegExp(message));assert.equal((await row(record.id)).state,'reserved');
    }await reset();const {record}=await reserve();await db.query("update apiwild_finance.gateway_requests set expires_at=now()-interval '1 second' where id=$1",[record.id]);assert.equal((await claim(record)).claimed,false);
  });
  await test('settlement and identical replay create one terminal debit and one outbox event',async()=>{
    await reset();const executing=(await claim((await reserve()).record)).record;
    const settled=await finish(executing);assert.equal(settled.replayed,false);assert.equal(settled.record.version,2);assert.equal(settled.record.cost_usd_micros,100);assert.equal(settled.record.cost_cny_micros,1000);
    assert.equal((await finish(executing)).replayed,true);assert.equal(await count('gateway_outbox'),1);
    const event=(await db.query('select payload from apiwild_finance.gateway_outbox')).rows[0].payload;
    assert.equal(event.customer_currency,'USD');assert.equal(event.provider_currency,'CNY');assert.equal(event.rate_version,rate);assert.match(event.settlement_reference,/SYNTHETIC/);
    await assert.rejects(finish(executing,{4:99}),/gateway_settlement_conflict/);
  });
  await test('successful work must be claimed; quote overrun stays held and freezes its supplier',async()=>{
    await reset();const {record}=await reserve();await assert.rejects(finish(record),/gateway_stale_settlement/);
    const executing=(await claim(record)).record;const outcome=await finish(executing,{4:801});assert.equal(outcome.settled,false);assert.equal(outcome.code,'gateway_settlement_exceeds_reservation');
    const current=await row(record.id);assert.equal(current.state,'uncertain');assert.equal(current.cost_usd_micros,'0');assert.equal(current.cost_cny_micros,'0');assert.equal(current.reserved_usd_micros,'800');assert.equal(await count('gateway_outbox'),0);
    assert.equal((await db.query('select accepted from apiwild_finance.provider_budgets')).rows[0].accepted,false);
    await assert.rejects(reserve({3:'request-held-after-overrun',8:1}),/gateway_provider_unavailable/);
    assert.equal((await finish(outcome.record)).code,'gateway_pricing_reconciliation_required');
  });
  await test('quote CNY10/observed CNY30 is retained; new reserve and previously reserved dispatch both freeze',async()=>{
    await reset({funded:10000});const first=(await reserve({9:10000000})).record;
    const second=(await reserve({0:other,3:'request-before-native-overrun',9:10000000})).record;
    const executing=(await claim(first)).record;const outcome=await finish(executing,{5:30000000});
    assert.equal(outcome.settled,false);assert.equal(outcome.record.observed_cny_micros,30000000);assert.equal(outcome.record.reserved_usd_micros,800);
    await assert.rejects(reserve({0:other,3:'request-after-native-overrun',8:1,9:1}),/gateway_provider_unavailable/);
    await assert.rejects(claim(second,db,other),/gateway_provider_unavailable/);assert.equal(await count('gateway_outbox'),0);
    // Even privileged accidental re-enablement cannot erase the CNY30 liability.
    await db.query('update apiwild_finance.provider_budgets set accepted=true');
    await assert.rejects(reserve({0:other,3:'request-after-unsafe-reenable',8:1,9:10000001}),/gateway_provider_limit/);
    assert.equal((await finish(outcome.record,{5:1})).settled,false);
  });
  await test('unknown outcome cannot redispatch; stale settlement CAS cannot release it',async()=>{
    await reset();const executing=(await claim((await reserve()).record)).record;const held=(await uncertain(executing)).record;
    assert.equal(held.state,'uncertain');assert.equal(held.version,2);assert.equal((await uncertain(executing)).replayed,true);assert.equal((await claim(held)).claimed,false);
    assert.equal((await reserve()).fresh,false);await assert.rejects(finish(executing),/gateway_stale_settlement/);assert.equal((await row(held.id)).state,'uncertain');
    assert.equal((await finish(held)).record.state,'succeeded');assert.equal(await count('gateway_outbox'),1);
  });
  await test('expiry cleanup releases only expired reserved work with the exact version',async()=>{
    await reset();const {record}=await reserve();assert.equal((await expire(record)).cancelled,false);
    await db.query("update apiwild_finance.gateway_requests set expires_at=now()-interval '1 second' where id=$1",[record.id]);
    assert.equal((await expire(record,db,owner,1)).cancelled,false);assert.equal((await expire(record)).cancelled,true);assert.equal((await expire(record)).cancelled,false);
    assert.equal(await count('gateway_outbox'),0);const executing=(await claim((await reserve({3:'request-after-unsent-expiry'})).record)).record;
    await db.query("update apiwild_finance.gateway_requests set expires_at=now()-interval '1 day' where id=$1",[executing.id]);
    assert.equal((await expire(executing)).cancelled,false);const held=(await uncertain(executing)).record;assert.equal((await expire(held)).cancelled,false);
    assert.equal((await row(held.id)).state,'uncertain');
  });
  await test('invalid null/shape/bounds/version settlement cannot release a reservation',async()=>{
    await reset();const executing=(await claim((await reserve()).record)).record;
    for(const index of [2,3,4,5,6,7,8])await assert.rejects(finish(executing,{[index]:null}),/gateway_invalid_settlement/);
    for(const changes of [{3:'other'},{4:-1},{5:-1},{6:''},{7:[]},{8:[]},{7:{text:'x'.repeat(1048576)}}])await assert.rejects(finish(executing,changes),/gateway_invalid_settlement/);
    await assert.rejects(uncertain(executing,db,owner,null),/gateway_invalid_version/);assert.equal((await row(executing.id)).state,'executing');
  });
  await test('outbox failure rolls back state, costs, version and result in the same transaction',async()=>{
    await reset();const executing=(await claim((await reserve()).record)).record;
    await db.query("create function public.fixture_reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'SYNTHETIC_OUTBOX_FAILURE'; end $$; create trigger fixture_reject_outbox before insert on apiwild_finance.gateway_outbox for each row execute function public.fixture_reject_outbox()");
    try{await assert.rejects(finish(executing),/SYNTHETIC_OUTBOX_FAILURE/);const current=await row(executing.id);assert.equal(current.state,'executing');assert.equal(current.version,'1');assert.equal(current.cost_usd_micros,'0');assert.equal(current.result_json,null);assert.equal(await count('gateway_outbox'),0);}
    finally{await db.query('drop trigger fixture_reject_outbox on apiwild_finance.gateway_outbox; drop function public.fixture_reject_outbox()');}
    assert.equal((await finish(executing)).replayed,false);assert.equal(await count('gateway_outbox'),1);
  });
  await test('failed customer response is free but actual supplier cost still uses native total allowance',async()=>{
    await reset({funded:10000});const executing=(await claim((await reserve({9:30000000})).record)).record;
    await assert.rejects(finish(executing,{3:'failed',4:1}),/gateway_invalid_settlement/);
    const settled=await finish(executing,{3:'failed',4:0,5:30000000});assert.equal(settled.record.cost_usd_micros,0);
    await assert.rejects(reserve({3:'request-after-failed-paid-leg',8:1,9:30000000}),/gateway_provider_limit/);assert.equal(await count('gateway_outbox'),1);
  });
  await test('20 requests/minute and overnight unknown holds remain bounded',async()=>{
    await reset({funded:1000000});for(let i=0;i<20;i++){const executing=(await claim((await reserve({3:'request-rpm-fixture-'+String(i).padStart(2,'0'),8:1,9:1})).record)).record;await finish(executing,{4:0,5:0});}
    await assert.rejects(reserve({3:'request-rpm-fixture-over'}),/gateway_customer_limit/);
    await reset({provider:3000});const {record}=await reserve();await db.query("update apiwild_finance.gateway_requests set created_at=now()-interval '1 day',updated_at=now()-interval '1 day' where id=$1",[record.id]);
    await assert.rejects(reserve({0:other,3:'request-overnight-native',8:1,9:1001}),/gateway_provider_limit/);
  });
  await test('all RPCs remain safe with an attacker-controlled search_path shadow',async()=>{
    await reset();await db.query('create temp table gateway_requests(id text); set search_path=pg_temp,public');
    try{const executing=(await claim((await reserve()).record)).record;await finish(executing);assert.equal(await count('gateway_outbox'),1);}
    finally{await db.query('reset search_path');}
  });
  console.log(JSON.stringify({database,clusterPath:identity.path,postgresVersion:identity.version,externalCalls:0,productionApplied:false,receiptVerification:'synthetic-only',runtimeActivated:false}));
}finally{clearTimeout(wallClock);await db.end();}

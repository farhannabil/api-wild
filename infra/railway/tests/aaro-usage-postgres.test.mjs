// Actual isolated PostgreSQL18 source fixtures. No production URL/secret/database or external call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,realpath,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {resolve,basename} from 'node:path';
import {openSync,closeSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2),['--isolated-pg18']);
const bin='C:/Users/farha/.claude/runtime/agent-tools/node_modules/paperclipai/node_modules/@embedded-postgres/windows-x64/native/bin';
const modulePath='C:/Users/farha/.claude/runtime/agent-tools/node_modules/paperclipai/node_modules/pg/lib/index.js';
const fixtureTemp='C:/Users/farha/AppData/Local/Temp';
const {Client}=createRequire(import.meta.url)(modulePath);
const childEnv={SystemRoot:'C:/Windows',PATH:bin+';C:/Windows/System32',TEMP:fixtureTemp,TMP:fixtureTemp};
const fixtureRole='aaro_usage_test';
const execute=(file,args,accepted=[0])=>new Promise((done,reject)=>{
  const log=absoluteCluster+'-command-'+basename(file)+'.log',fd=openSync(log,'a');
  const child=spawn(file,args,{env:childEnv,windowsHide:true,stdio:['ignore',fd,fd]}),timer=setTimeout(()=>child.kill(),60_000);closeSync(fd);timer.unref();
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',(code,signal)=>{clearTimeout(timer);accepted.includes(code)?done({code}):reject(Object.assign(new Error('Isolated PG command failed: '+basename(file)+'; log '+log),{code,signal}));});
});
for(const file of [bin+'/initdb.exe',bin+'/pg_ctl.exe',modulePath])assert.equal((await stat(file)).isFile(),true);
const cluster=await mkdtemp(fixtureTemp+'/aaro-usage-pg-'),absoluteCluster=resolve(await realpath(cluster));
const validCluster=()=>assert.match(absoluteCluster.replaceAll('\\','/'),/^C:\/Users\/farha\/AppData\/Local\/Temp\/aaro-usage-pg-[A-Za-z0-9]+$/);
validCluster();
const port=await new Promise((done,reject)=>{const probe=createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();assert.ok(address&&typeof address!=='string');probe.close(error=>error?reject(error):done(address.port));});});
const options={host:'127.0.0.1',port,user:fixtureRole,database:'postgres',password:()=>'',ssl:false,connectionTimeoutMillis:5000,query_timeout:15000,options:'-c statement_timeout=10s -c lock_timeout=5s'};
let started=false,db,cleanupPromise;
async function stopFixture(interrupted=false){
  cleanupPromise??=(async()=>{
    if(interrupted)db?.on('error',()=>{});else await db?.end();
    if(started){validCluster();assert.equal(resolve(await realpath(absoluteCluster)),absoluteCluster);
      const stopped=await execute(bin+'/pg_ctl.exe',['-D',absoluteCluster,'-m','fast','-w','stop']);
      const status=await execute(bin+'/pg_ctl.exe',['-D',absoluteCluster,'status'],[3]);started=false;
      console.log(JSON.stringify({fixtureStopped:stopped.code===0,statusExit:status.code,retainedData:true,cluster:absoluteCluster}));
    }
    if(interrupted)await db?.end();
  })();return cleanupPromise;
}
const wallClock=setTimeout(()=>{console.error('Isolated AARO finance test deadline reached.');void stopFixture(true).then(()=>process.exit(124),()=>process.exit(125));},180000);wallClock.unref();
const USER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const owner='test:supabase:'+USER,other='test:supabase:'+OTHER;
const accepted='a'.repeat(64),admission='b'.repeat(64),reconciliation='c'.repeat(64);
const key='aaro-isolated-fixture',tariff='fixture-UNACCEPTED-NOT-A-PRICE',model='fixture/model';
const binding=(changes={})=>({protocol:'aaro-subrouter-usage-v1',product:'aaro',owner,mode:'test',keyReference:key,tariffVersion:tariff,acceptanceReceiptSHA256:accepted,model,
  requestKey:crypto.randomUUID(),payloadHash:'d'.repeat(64),maximumInputTokens:100,maximumOutputTokens:20,totalCapNativeCnyMicros:50_000_000,...changes});
const query=async(sql,params=[],client=db)=>(await client.query(sql,params)).rows[0]?.value;
const reserve=(b=binding(),client=db)=>query('select public.aaro_usage_reserve_v1($1,$2::jsonb) as value',[b.owner,JSON.stringify(b)],client);
const read=r=>query('select public.aaro_usage_read_v1($1,$2) as value',[r.owner,r.id]);
const claim=(r,client=db,b=r.binding)=>query('select public.aaro_usage_claim_v1($1,$2,$3::jsonb) as value',[r.owner,r.id,JSON.stringify(b)],client);
const fact=(r,changes={})=>({providerRequestId:'provider-'+r.id,inputTokens:10,outputTokens:2,actualNativeCnyMicros:12,supplierDebitReference:'debit-'+r.id,reconciliationReceiptSHA256:reconciliation,observedOnly:false,...changes});
const settle=(r,f=fact(r),client=db)=>query('select public.aaro_usage_settle_v1($1,$2,$3::jsonb,$4::jsonb) as value',[r.owner,r.id,JSON.stringify(r.binding),JSON.stringify(f)],client);
const uncertain=(r,client=db)=>query('select public.aaro_usage_uncertain_v1($1,$2) as value',[r.owner,r.id],client);
const expire=(r,client=db)=>query('select public.aaro_usage_expire_v1($1,$2) as value',[r.owner,r.id],client);
async function reset({credits=1000,nativeSpent=0,acceptedBudget=true,acceptedTariff=true,frozen=false,paid=true}={}){
  await db.query('reset role');
  await db.query('truncate aaro_finance.usage_outbox,aaro_finance.liability_observations,aaro_finance.requests,aaro_finance.credit_periods,aaro_finance.subscriptions,aaro_finance.accounts,aaro_finance.tariffs,aaro_finance.product_budgets,aaro_finance.aggregate_budget');
  await db.query('update auth.users set email_confirmed_at=now(),is_anonymous=false');
  for(const [who,id,suffix] of [[owner,USER,'one'],[other,OTHER,'two']]){
    await db.query("insert into aaro_finance.accounts(owner,customer_id,billing_mode,frozen) values($1,$2,'test',$3)",[who,id,frozen]);
    await db.query("insert into aaro_finance.subscriptions(id,owner,account_id,billing_mode,plan_reference,status,projection_receipt_sha256) values($1,$2,'acct_1UCiHk0SGcPsf6AA','test','fixture-plan','active',$3)",['sub_'+suffix,who,accepted]);
    await db.query("insert into aaro_finance.credit_periods(invoice_id,subscription_id,owner,credits,period_start,period_end,paid,frozen,projection_receipt_sha256) values($1,$2,$3,$4,now()-interval '1 minute',now()+interval '1 hour',$5,false,$6)",['in_'+suffix,'sub_'+suffix,who,credits,paid,accepted]);
  }
  await db.query("insert into aaro_finance.aggregate_budget(product,spent_native_cny_micros,accepted) values('aaro',$1,$2)",[nativeSpent,acceptedBudget]);
  await db.query("insert into aaro_finance.product_budgets(key_reference,billing_mode,tariff_version,acceptance_receipt_sha256,admission_receipt_sha256,max_call_native_cny_micros,spent_native_cny_micros,accepted) values($1,'test',$2,$3,$4,10000,$5,$6)",[key,tariff,accepted,admission,nativeSpent,acceptedBudget]);
  await db.query("insert into aaro_finance.tariffs(version,model,max_input_tokens,max_output_tokens,input_credits_per_million,output_credits_per_million,input_native_cny_micros_per_million,output_native_cny_micros_per_million,accepted,acceptance_receipt_sha256) values($1,$2,128000,4096,1000000,4000000,1000000,1000000,$3,$4)",[tariff,model,acceptedTariff,accepted]);
}
async function rows(table){return(await db.query('select * from aaro_finance.'+table)).rows;}
async function parallel(count,work){
  const clients=Array.from({length:count},()=>new Client(options));
  try{await Promise.all(clients.map(c=>c.connect()));return await Promise.allSettled(clients.map((c,i)=>work(c,i)));}
  finally{await Promise.all(clients.map(c=>c.end()));}
}
try{
  await execute(bin+'/initdb.exe',['-D',absoluteCluster,'-U',fixtureRole,'-A','trust','--encoding=UTF8','--no-locale','--no-sync']);
  await execute(bin+'/pg_ctl.exe',['-D',absoluteCluster,'-l',absoluteCluster+'/fixture.log','-o','-h 127.0.0.1 -p '+port,'-w','start']);started=true;
  db=new Client(options);await db.connect();
  const identity=(await db.query("select current_setting('data_directory') as path,current_setting('server_version_num')::integer as version,current_user as owner")).rows[0];
  assert.equal(resolve(await realpath(identity.path)),absoluteCluster);assert.equal(identity.owner,fixtureRole);assert.equal(Math.floor(identity.version/10000),18);
  await db.query("create role anon nologin;create role authenticated nologin;create role service_role nologin;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean not null default false)");
  await db.query('insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now())',[USER,OTHER]);
  await db.query("create schema apiwild_finance;create table apiwild_finance.fixture_preserved(amount_usd_micros bigint);insert into apiwild_finance.fixture_preserved values(12345)");
  const schema=await readFile(new URL('../runtime/aaro-usage.schema.sql',import.meta.url),'utf8');
  await test('PG18 AARO schema compiles/reapplies, uses nine private RLS tables and seeds no financial records',async()=>{
    await db.query(schema);await db.query(schema);
    const tables=(await db.query("select relname,relrowsecurity from pg_class where relnamespace='aaro_finance'::regnamespace and relkind='r'")).rows;
    assert.equal(tables.length,9);assert.ok(tables.every(t=>t.relrowsecurity));
    for(const table of tables)assert.equal((await rows(table.relname)).length,0);
    const functions=(await db.query("select prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like 'aaro_usage_%_v1'")).rows;
    assert.equal(functions.length,6);for(const fn of functions){assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.includes('search_path=\"\"'));assert.ok(fn.proconfig.includes('lock_timeout=5s'));assert.ok(fn.proconfig.includes('statement_timeout=20s'));}
    assert.equal((await db.query('select amount_usd_micros from apiwild_finance.fixture_preserved')).rows[0].amount_usd_micros,'12345');
  });
  await test('anon/authenticated cannot access backing tables or any AARO RPC; service role cannot directly change funds',async()=>{
    await reset();const b=binding();
    for(const role of ['anon','authenticated']){
      await db.query('set role '+role);
      try{
        await assert.rejects(reserve(b),e=>e.code==='42501');
        for(const table of ['accounts','subscriptions','credit_periods','aggregate_budget','product_budgets','tariffs','requests','liability_observations','usage_outbox'])await assert.rejects(db.query('select * from aaro_finance.'+table),e=>e.code==='42501');
      }finally{await db.query('reset role');}
    }
    await db.query('set role service_role');
    try{await assert.rejects(db.query('update aaro_finance.credit_periods set credits=10000000'),e=>e.code==='42501');assert.equal((await reserve(b)).fresh,true);}
    finally{await db.query('reset role');}
  });
  await test('unaccepted funding/tariffs/budgets and unconfirmed/anonymous/frozen customers cannot reserve',async()=>{
    for(const config of [{frozen:true},{paid:false},{acceptedBudget:false},{acceptedTariff:false}]){
      await reset(config);await assert.rejects(reserve());assert.equal((await rows('requests')).length,0);
    }
    for(const sql of ['update auth.users set email_confirmed_at=null','update auth.users set is_anonymous=true']){
      await reset();await db.query(sql);await assert.rejects(reserve(),e=>e.message==='aaro_customer_unaccepted');assert.equal((await rows('requests')).length,0);
    }
  });
  await test('32 simultaneous reservations cannot overdraw the same invoice credits',async()=>{
    await reset({credits:200});const results=await parallel(32,(c)=>reserve(binding(),c));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const period=(await rows('credit_periods')).find(p=>p.owner===owner);
    assert.equal(period.reserved_credits,'180');assert.equal(period.spent_credits,'0');assert.equal((await rows('requests')).length,1);
  });
  await test('CNY50 TOTAL admission serializes globally across distinct owners',async()=>{
    await reset({nativeSpent:49_999_880});const results=await parallel(2,(c,i)=>reserve(binding({owner:i?other:owner}),c));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const budget=(await rows('product_budgets'))[0];assert.equal(Number(budget.spent_native_cny_micros)+Number(budget.reserved_native_cny_micros),50_000_000);
  });
  await test('one aggregate CNY50 allowance covers different keys, live/test modes and key rotation',async()=>{
    await reset({nativeSpent:49_999_880});
    const liveOwner='live:supabase:'+OTHER,liveKey='aaro-isolated-live-key';
    await db.query("insert into aaro_finance.accounts(owner,customer_id,billing_mode,frozen) values($1,$2,'live',false)",[liveOwner,OTHER]);
    await db.query("insert into aaro_finance.subscriptions(id,owner,account_id,billing_mode,plan_reference,status,projection_receipt_sha256) values('sub_livefixture',$1,'acct_1UCiHN194XZKj6cF','live','fixture-plan','active',$2)",[liveOwner,accepted]);
    await db.query("insert into aaro_finance.credit_periods(invoice_id,subscription_id,owner,credits,period_start,period_end,paid,frozen,projection_receipt_sha256) values('in_livefixture','sub_livefixture',$1,1000,now()-interval '1 minute',now()+interval '1 hour',true,false,$2)",[liveOwner,accepted]);
    await db.query("insert into aaro_finance.product_budgets(key_reference,billing_mode,tariff_version,acceptance_receipt_sha256,admission_receipt_sha256,max_call_native_cny_micros,accepted) values($1,'live',$2,$3,$4,10000,true)",[liveKey,tariff,accepted,admission]);
    const choices=[binding(),binding({owner:liveOwner,mode:'live',keyReference:liveKey})];
    const results=await parallel(2,(client,i)=>reserve(choices[i],client));assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
    assert.equal(results.filter(v=>v.status==='rejected'&&v.reason.message==='aaro_native_budget_exhausted').length,1);
    const aggregate=(await rows('aggregate_budget'))[0];assert.equal(aggregate.spent_native_cny_micros,'49999880');assert.equal(aggregate.reserved_native_cny_micros,'120');
    await db.query("insert into aaro_finance.product_budgets(key_reference,billing_mode,tariff_version,acceptance_receipt_sha256,admission_receipt_sha256,max_call_native_cny_micros,accepted) values('aaro-rotated-key','test',$1,$2,$3,10000,true)",[tariff,accepted,admission]);
    await assert.rejects(reserve(binding({owner:other,keyReference:'aaro-rotated-key'})),e=>e.message==='aaro_native_budget_exhausted');
    assert.equal((await rows('requests')).length,1);
  });
  await test('trusted token overrun retains receipt/liability and freezes global admission across other keys',async()=>{
    await reset();
    await db.query("insert into aaro_finance.product_budgets(key_reference,billing_mode,tariff_version,acceptance_receipt_sha256,admission_receipt_sha256,max_call_native_cny_micros,accepted) values('aaro-other-key','test',$1,$2,$3,10000,true)",[tariff,accepted,admission]);
    const r=(await reserve()).record;await claim(r);const waiting=(await reserve(binding({owner:other,keyReference:'aaro-other-key'}))).record;
    const result=await settle(r,fact(r,{inputTokens:101,outputTokens:21,actualNativeCnyMicros:250}));
    assert.equal(result.settled,false);assert.equal(result.record.state,'uncertain');assert.equal(result.record.input_tokens,101);assert.equal(result.record.output_tokens,21);
    assert.equal(result.record.observed_native_cny_micros,250);assert.equal(result.record.provider_request_id,fact(r).providerRequestId);assert.equal(result.record.supplier_debit_reference,fact(r).supplierDebitReference);
    assert.equal(result.record.reconciliation_receipt_sha256,reconciliation);assert.equal(result.record.actual_credits,0);assert.equal((await rows('usage_outbox')).length,0);
    let aggregate=(await rows('aggregate_budget'))[0];assert.equal(aggregate.accepted,false);assert.equal(aggregate.reserved_native_cny_micros,'240');assert.equal(aggregate.observed_excess_native_cny_micros,'130');
    await assert.rejects(claim(waiting),e=>e.message==='aaro_claim_unaccepted');await assert.rejects(reserve(binding({owner:other,keyReference:'aaro-other-key'})),e=>e.message==='aaro_budget_unaccepted');
    await settle(r,fact(r,{inputTokens:102,actualNativeCnyMicros:300,reconciliationReceiptSHA256:'e'.repeat(64)}));aggregate=(await rows('aggregate_budget'))[0];assert.equal(aggregate.observed_excess_native_cny_micros,'180');
    await settle(r,fact(r,{reconciliationReceiptSHA256:'f'.repeat(64)}));aggregate=(await rows('aggregate_budget'))[0];assert.equal(aggregate.observed_excess_native_cny_micros,'180');assert.equal((await read(r)).record.observed_native_cny_micros,300);
    await assert.rejects(settle(r,fact(r,{supplierDebitReference:'foreign-debit'})),e=>e.message==='aaro_settlement_conflict');
    assert.equal((await expire(r)).cancelled,false);assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).reserved_credits,'180');
  });
  await test('trusted observations retain exact immutable receipt facts without combining incompatible tuples',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);
    const first=fact(r,{inputTokens:100,outputTokens:0,actualNativeCnyMicros:121,reconciliationReceiptSHA256:'a'.repeat(64)});
    const correction=fact(r,{inputTokens:1,outputTokens:100,actualNativeCnyMicros:50,reconciliationReceiptSHA256:'b'.repeat(64)});
    await settle(r,first);await settle(r,correction);let current=(await read(r)).record;
    assert.equal(current.observed_native_cny_micros,121);assert.equal(current.input_tokens,1);assert.equal(current.output_tokens,100);assert.equal(current.reconciliation_receipt_sha256,correction.reconciliationReceiptSHA256);
    let observations=await rows('liability_observations');assert.equal(observations.length,2);
    for(const expected of [first,correction]){const saved=observations.find(o=>o.reconciliation_receipt_sha256===expected.reconciliationReceiptSHA256);
      assert.equal(saved.input_tokens,String(expected.inputTokens));assert.equal(saved.output_tokens,String(expected.outputTokens));assert.equal(saved.native_cny_micros,String(expected.actualNativeCnyMicros));assert.equal(saved.provider_request_id,expected.providerRequestId);assert.equal(saved.supplier_debit_reference,expected.supplierDebitReference);}
    await assert.rejects(settle(r,{...first,actualNativeCnyMicros:122}),e=>e.message==='aaro_settlement_conflict');
    await settle(r,first);assert.equal((await rows('liability_observations')).length,2);assert.equal((await rows('aggregate_budget'))[0].observed_excess_native_cny_micros,'1');
    await settle(r,{...first,actualNativeCnyMicros:250,reconciliationReceiptSHA256:'e'.repeat(64)});observations=await rows('liability_observations');assert.equal(observations.length,3);assert.equal((await rows('aggregate_budget'))[0].observed_excess_native_cny_micros,'130');
    assert.equal((await rows('usage_outbox')).length,0);assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).spent_credits,'0');
  });
  await test('trusted usage disagreement or huge bounded observation quarantines without customer debit or lost hold',async()=>{
    for(const changes of [{inputTokens:9,outputTokens:1,actualNativeCnyMicros:0,observedOnly:true},{inputTokens:1000000000,outputTokens:1000000000,actualNativeCnyMicros:9007199254740991}]){
      await reset();const r=(await reserve()).record;await claim(r);const result=await settle(r,fact(r,changes));
      assert.equal(result.settled,false);assert.equal(result.record.state,'uncertain');assert.equal(result.record.actual_credits,0);assert.equal(result.record.actual_native_cny_micros,0);
      const aggregate=(await rows('aggregate_budget'))[0];assert.equal(aggregate.accepted,false);assert.equal(aggregate.reserved_native_cny_micros,'120');
      assert.equal(aggregate.observed_excess_native_cny_micros,String(Math.max(0,changes.actualNativeCnyMicros-120)));assert.equal((await rows('usage_outbox')).length,0);
    }
  });
  await test('concurrent duplicates reserve once; changed owner/mode/key/payload/price requests cannot reuse authority',async()=>{
    await reset();const b=binding();const results=await parallel(16,c=>reserve(b,c));assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.fresh).length,1);
    assert.equal((await rows('requests')).length,1);
    await assert.rejects(reserve({...b,payloadHash:'e'.repeat(64)}),e=>e.message==='aaro_request_conflict');
    for(const patch of [{protocol:null},{owner:'test:supabase:bad'},{mode:'live'},{keyReference:'different-key'},{maximumInputTokens:128001},{maximumOutputTokens:4097},{totalCapNativeCnyMicros:100000000},{maximumCredits:1}])await assert.rejects(reserve({...b,...patch}));
    assert.equal((await rows('requests')).length,1);
  });
  await test('two-held-request owner limit remains separate from native money and invoice units',async()=>{
    await reset();await reserve();await reserve();await assert.rejects(reserve(),e=>e.message==='aaro_concurrent_limit');
    assert.equal((await rows('requests')).length,2);assert.equal((await rows('product_budgets'))[0].reserved_native_cny_micros,'240');
  });
  await test('32 claims for one receipt yield exactly one provider dispatch admission',async()=>{
    await reset();const r=(await reserve()).record;const results=await parallel(32,c=>claim(r,c));
    assert.equal(results.filter(v=>v.status==='fulfilled'&&v.value.claimed).length,1);
    assert.equal((await read(r)).record.state,'executing');await assert.rejects(claim(r,db,{...r.binding,model:'different/model'}),e=>e.message==='aaro_request_conflict');
  });
  await test('expired/refunded/held period or unaccepted provider budget prevents claiming and retains the reservation',async()=>{
    for(const sql of ["update aaro_finance.requests set expires_at=now()-interval '1 second'","update aaro_finance.credit_periods set frozen=true","update aaro_finance.subscriptions set status='held'","update aaro_finance.product_budgets set accepted=false","update aaro_finance.aggregate_budget set accepted=false"]){
      await reset();const r=(await reserve()).record;await db.query(sql);await assert.rejects(claim(r),e=>e.message==='aaro_claim_unaccepted');
      assert.equal((await read(r)).record.state,'reserved');assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).reserved_credits,'180');
    }
  });
  await test('claim rechecks retired/rotated budget policy, tariff receipt, rates and bounds before dispatch',async()=>{
    for(const sql of ["update aaro_finance.product_budgets set billing_mode='live'","update aaro_finance.product_budgets set tariff_version='different-version'","update aaro_finance.product_budgets set acceptance_receipt_sha256=repeat('e',64)","update aaro_finance.product_budgets set admission_receipt_sha256=repeat('e',64)","update aaro_finance.product_budgets set max_call_native_cny_micros=1","update aaro_finance.tariffs set accepted=false","update aaro_finance.tariffs set acceptance_receipt_sha256=repeat('e',64)","update aaro_finance.tariffs set input_credits_per_million=2","update aaro_finance.tariffs set input_native_cny_micros_per_million=2","update aaro_finance.tariffs set max_input_tokens=1"]) {
      await reset();const r=(await reserve()).record;await db.query(sql);await assert.rejects(claim(r),e=>e.message==='aaro_claim_unaccepted');assert.equal((await read(r)).record.state,'reserved');
    }
  });
  await test('settlement debits customer units/native CNY and creates one outbox event exactly once under contention',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);
    const results=await parallel(16,c=>settle(r,fact(r),c));assert.ok(results.every(v=>v.status==='fulfilled'&&v.value.settled));assert.equal(results.filter(v=>!v.value.replayed).length,1);
    assert.equal((await rows('usage_outbox')).length,1);const period=(await rows('credit_periods')).find(p=>p.owner===owner),budget=(await rows('product_budgets'))[0];
    assert.equal(period.spent_credits,'18');assert.equal(period.reserved_credits,'0');assert.equal(budget.spent_native_cny_micros,'12');assert.equal(budget.reserved_native_cny_micros,'0');
    const aggregate=(await rows('aggregate_budget'))[0];assert.equal(aggregate.spent_native_cny_micros,'12');assert.equal(aggregate.reserved_native_cny_micros,'0');
    await assert.rejects(settle(r,fact(r,{actualNativeCnyMicros:13})),e=>e.message==='aaro_settlement_conflict');
  });
  await test('changed/foreign/oversized provider usage cannot silently settle or release a reservation',async()=>{
    await reset();const r=(await reserve()).record;await assert.rejects(settle(r),e=>e.message==='aaro_request_unclaimed');await claim(r);
    for(const changes of [{inputTokens:1000000001},{inputTokens:0},{outputTokens:1000000001},{inputTokens:'10'},{actualNativeCnyMicros:1.5},{providerRequestId:null},{reconciliationReceiptSHA256:'bad'}])await assert.rejects(settle(r,fact(r,changes)));
    await assert.rejects(query('select public.aaro_usage_read_v1($1,$2) as value',[other,r.id]),e=>e.message==='aaro_request_not_found');
    assert.equal((await read(r)).record.state,'executing');assert.equal((await rows('usage_outbox')).length,0);
  });
  await test('one native supplier debit/provider request cannot settle two AARO reservations',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);await settle(r);
    const second=(await reserve()).record;await claim(second);await assert.rejects(settle(second,fact(second,{supplierDebitReference:fact(r).supplierDebitReference})),e=>e.code==='23505');
    assert.equal((await read(second)).record.state,'executing');assert.equal((await rows('usage_outbox')).length,1);
    assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).reserved_credits,'180');
  });
  await test('quote overrun commits observed liability/freeze and cannot be erased by ordinary settlement',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);
    const exceeded=await settle(r,fact(r,{actualNativeCnyMicros:121}));assert.equal(exceeded.settled,false);
    assert.equal(exceeded.record.state,'uncertain');assert.equal(exceeded.record.observed_native_cny_micros,121);
    assert.equal((await rows('product_budgets'))[0].accepted,false);assert.equal((await rows('product_budgets'))[0].reserved_native_cny_micros,'120');
    assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).frozen,true);
    assert.equal((await settle(r,fact(r,{reconciliationReceiptSHA256:'f'.repeat(64)}))).settled,false);await assert.rejects(reserve(),e=>e.message==='aaro_budget_unaccepted');assert.equal((await expire(r)).cancelled,false);
  });
  await test('uncertain executing work is idempotently held and is never expiry-cancelled',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);assert.equal((await uncertain(r)).held,true);assert.equal((await uncertain(r)).record.state,'uncertain');
    await db.query("update aaro_finance.requests set expires_at=now()-interval '1 hour'");
    assert.equal((await expire(r)).cancelled,false);assert.equal((await rows('product_budgets'))[0].reserved_native_cny_micros,'120');
  });
  await test('expiry releases only never-claimed elapsed reservations and remains idempotent under contention',async()=>{
    await reset();const r=(await reserve()).record;assert.equal((await expire(r)).cancelled,false);
    await db.query("update aaro_finance.requests set expires_at=now()-interval '1 second'");
    const results=await parallel(16,c=>expire(r,c));assert.ok(results.every(v=>v.status==='fulfilled'&&v.value.cancelled));
    assert.equal(results.filter(v=>!v.value.replayed).length,1);assert.equal((await rows('product_budgets'))[0].reserved_native_cny_micros,'0');assert.equal((await rows('aggregate_budget'))[0].reserved_native_cny_micros,'0');
    assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).reserved_credits,'0');assert.equal((await read(r)).record.state,'cancelled');
  });
  await test('snapshotted accepted credit tariff is immutable through a pending request',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);
    await db.query('update aaro_finance.tariffs set input_credits_per_million=0,output_credits_per_million=0');
    assert.equal((await settle(r)).record.actual_credits,18);
  });
  await test('outbox insertion failure rolls back state and both financial debits',async()=>{
    await reset();const r=(await reserve()).record;await claim(r);
    await db.query("create function aaro_finance.fixture_outbox_failure() returns trigger language plpgsql as $$begin raise exception 'fixture_outbox_failure';end;$$;create trigger fixture_outbox_failure before insert on aaro_finance.usage_outbox for each row execute function aaro_finance.fixture_outbox_failure()");
    try{await assert.rejects(settle(r),e=>e.message==='fixture_outbox_failure');assert.equal((await read(r)).record.state,'executing');
      assert.equal((await rows('product_budgets'))[0].spent_native_cny_micros,'0');assert.equal((await rows('aggregate_budget'))[0].spent_native_cny_micros,'0');assert.equal((await rows('aggregate_budget'))[0].reserved_native_cny_micros,'120');assert.equal((await rows('liability_observations')).length,0);assert.equal((await rows('credit_periods')).find(p=>p.owner===owner).spent_credits,'0');
    }finally{await db.query('drop trigger fixture_outbox_failure on aaro_finance.usage_outbox;drop function aaro_finance.fixture_outbox_failure()');}
  });
  await test('time is refreshed after contention; a period expiring behind the budget lock cannot admit work',async()=>{
    await reset();const holder=new Client(options),waiting=new Client(options);await holder.connect();await waiting.connect();
    try{
      await db.query("update aaro_finance.credit_periods set period_end=clock_timestamp()+interval '150 milliseconds' where owner=$1",[owner]);
      await holder.query('begin');await holder.query('select * from aaro_finance.product_budgets for update');
      const pending=reserve(binding(),waiting);await holder.query('select pg_sleep(0.25)');await holder.query('commit');
      await assert.rejects(pending,e=>e.message==='aaro_credits_insufficient');assert.equal((await rows('requests')).length,0);
    }finally{await holder.query('rollback');await holder.end();await waiting.end();}
  });
  await test('unsupported transaction isolation is rejected and API WILD fixture is preserved',async()=>{
    await reset();await db.query('begin isolation level repeatable read');
    try{await assert.rejects(reserve(),e=>e.message==='aaro_isolation_unsupported');}finally{await db.query('rollback');}
    assert.equal((await db.query('select amount_usd_micros from apiwild_finance.fixture_preserved')).rows[0].amount_usd_micros,'12345');
  });
}finally{clearTimeout(wallClock);await stopFixture();}

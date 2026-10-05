// Local in-memory database only. No deployed queue or real recipients.
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();
try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema apiwild_finance;grant usage on schema apiwild_finance to service_role;
    create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,raw_user_meta_data jsonb);
    create table public.brand_registry(slug text primary key,active boolean);
    create table public.customer_brand_memberships(customer_id uuid,brand_slug text,status text default 'active',unique(customer_id,brand_slug));
    create table public.crm_events(event_key text unique,customer_id uuid,brand_slug text,event_type text);
    create table public.email_outbox(id uuid primary key default gen_random_uuid(),event_key text unique,customer_id uuid,brand_slug text,
      recipient text,template text,status text default 'pending',scheduled_at timestamptz default now(),attempts int default 0,
      last_error text,updated_at timestamptz default now(),sent_at timestamptz);
    insert into brand_registry values('apiwild',true),('aaro',true);`);
  for(const file of ['20261003050100_confirmed_welcome_outbox.sql','20261005084105_apiwild_welcome_brand_scope.sql'])
    await db.exec(await readFile(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8'));
  const functions=(await db.query(`select n.nspname as schema,p.prosecdef as definer,
    has_function_privilege('anon',p.oid,'execute') as anon_execute,
    has_function_privilege('authenticated',p.oid,'execute') as customer_execute,
    has_function_privilege('service_role',p.oid,'execute') as server_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname='claim_apiwild_confirmed_welcome' order by n.nspname`)).rows;
  assert.deepEqual(functions,[
    {schema:'apiwild_finance',definer:true,anon_execute:false,customer_execute:false,server_execute:true},
    {schema:'public',definer:false,anon_execute:false,customer_execute:false,server_execute:true},
  ]);
  console.log('PASS private privileged helper, public invoker wrapper and server-only execute grants');
  await db.exec(`insert into auth.users values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture-a@example.test',now(),false,'{}'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','fixture-b@example.test',now(),false,'{"signup_product":"aaro"}');
    update email_outbox set idempotency_started_at=now()-interval '24 hours' where brand_slug='aaro';`);
  const before=(await db.query("select * from email_outbox where brand_slug='aaro'")).rows[0];
  await db.exec('set role service_role');
  const first=(await db.query('select * from claim_apiwild_confirmed_welcome(5)')).rows;
  const replay=(await db.query('select * from claim_apiwild_confirmed_welcome(5)')).rows;
  await db.exec('reset role');
  assert.equal(first.length,1);assert.equal(first[0].brand_slug,'apiwild');assert.equal(replay.length,0);
  assert.deepEqual((await db.query("select * from email_outbox where brand_slug='aaro'")).rows[0],before);
  assert.equal((await db.query('select attempts from email_delivery_budget')).rows[0].attempts,1);
  console.log('PASS API WILD-only claim/cleanup, ambiguous processing not replayed, shared budget increment');
  await db.exec('set role authenticated');await assert.rejects(db.query('select * from claim_apiwild_confirmed_welcome(1)'));await db.exec('reset role');
  await db.exec("set role service_role;set request.jwt.claim.sub='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
  await assert.rejects(db.query('select * from claim_apiwild_confirmed_welcome(1)'));
  await db.exec("reset request.jwt.claim.sub;reset role");
  console.log('PASS no customer role/JWT authority');
  await db.exec("update email_outbox set status='pending',lease_id=null where brand_slug='apiwild';update email_delivery_budget set attempts=10;set role service_role");
  assert.equal((await db.query('select * from claim_apiwild_confirmed_welcome(1)')).rows.length,0);
  await db.exec('reset role');assert.equal((await db.query('select attempts from email_delivery_budget')).rows[0].attempts,10);
  console.log('PASS aggregate daily budget remains ten');
}finally{await db.close();}

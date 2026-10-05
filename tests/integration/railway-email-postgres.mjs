// Explicit, isolated test cluster only. Never accepts DATABASE_URL or credentials.
// node tests/integration/railway-email-postgres.mjs PORT /absolute/path/to/pg/lib/index.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !process.argv[3]) throw new Error('Explicit isolated test port and installed pg module required');
const {Client} = createRequire(import.meta.url)(process.argv[3]);
const options = {host: '127.0.0.1', port, user: 'outbox_test', database: 'postgres', connectionTimeoutMillis: 5000};
const admin = new Client(options); await admin.connect();
const directory = (await admin.query("select current_setting('data_directory') as path")).rows[0].path;
assert.match(directory.replaceAll('\\', '/'), /\/Temp\/apiwild-outbox-pg-[A-Za-z0-9]+$/);
const database = 'outbox_acceptance_' + randomUUID().replaceAll('-', '');
await admin.query(`create database ${database}`); await admin.end();
const db = new Client({...options,database}); await db.connect();
const migration = await readFile(new URL('../../supabase/migrations/20261003050100_confirmed_welcome_outbox.sql', import.meta.url), 'utf8');
let claimed;
const customer = '12345678-1234-4123-8123-123456789abc';
const anonymous = '22345678-1234-4123-8123-123456789abc';
try {
  await db.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $$;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean default false, raw_user_meta_data jsonb default '{}');
    create table public.brand_registry (slug text primary key, active boolean default true);
    insert into public.brand_registry values ('apiwild',true),('aaro',true);
    create table public.customer_brand_memberships (customer_id uuid references auth.users(id),brand_slug text references public.brand_registry(slug),status text default 'active',primary key(customer_id,brand_slug));
    create table public.crm_events (id uuid primary key default gen_random_uuid(),event_key text unique,customer_id uuid references auth.users(id),brand_slug text,event_type text);
    create table public.email_outbox (id uuid primary key default gen_random_uuid(),event_key text unique,customer_id uuid references auth.users(id),brand_slug text,recipient text,template text,
      status text default 'pending' check(status in ('pending','processing','sent','suppressed','failed')),attempts integer default 0 check(attempts>=0),scheduled_at timestamptz default now(),sent_at timestamptz,last_error text,created_at timestamptz default now(),updated_at timestamptz default now());`);
  await test('migration compiles against actual PostgreSQL and is repeatable', async () => {
    await db.query(migration); await db.query(migration);
    assert.equal((await db.query("select count(*)::integer as n from pg_trigger where tgname='on_customer_email_confirmed_welcome'")).rows[0].n, 1);
  });
  await test('unconfirmed signup does not queue a welcome', async () => {
    await db.query('insert into auth.users(id,email) values($1,$2)', [customer,'delivered@resend.dev']);
    assert.equal((await db.query('select count(*)::integer as n from email_outbox')).rows[0].n,0);
  });
  await test('confirmation queues exactly one membership, event and welcome', async () => {
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[customer]);
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[customer]);
    for (const table of ['customer_brand_memberships','crm_events','email_outbox']) assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n,1);
  });
  await test('anonymous confirmed records cannot queue', async () => {
    await db.query('insert into auth.users(id,email,email_confirmed_at,is_anonymous) values($1,$2,now(),true)',[anonymous,'delivered@resend.dev']);
    assert.equal((await db.query('select count(*)::integer as n from email_outbox')).rows[0].n,1);
  });
  await test('anonymous and authenticated roles cannot invoke worker RPCs', async () => {
    for (const role of ['anon','authenticated']) {
      await db.query(`set role ${role}`);
      await assert.rejects(db.query('select * from public.claim_confirmed_welcome(1)'), e=>e.code==='42501');
      await db.query('reset role');
    }
  });
  await test('service role can claim exactly once; processing is not reclaimed', async () => {
    await db.query('set role service_role');
    claimed=(await db.query('select * from public.claim_confirmed_welcome(1)')).rows[0];
    assert.equal(claimed.recipient,'delivered@resend.dev'); assert.ok(claimed.lease_id);
    assert.equal((await db.query('select * from public.claim_confirmed_welcome(1)')).rows.length,0);
    await db.query('reset role');
  });
  await test('stale lease cannot finish another claim', async () => {
    await assert.rejects(db.query("select public.finish_confirmed_welcome($1,$2,'sent',$3)",[claimed.id,customer,anonymous]),/email_lease_mismatch/);
  });
  await test('ambiguous provider result stays processing, including beyond 24h', async () => {
    await db.query("select public.finish_confirmed_welcome($1,$2,'ambiguous',null)",[claimed.id,claimed.lease_id]);
    await db.query("update email_outbox set idempotency_started_at=now()-interval '25 hours' where id=$1",[claimed.id]);
    assert.equal((await db.query('select * from public.claim_confirmed_welcome(1)')).rows.length,0);
  });
  await test('expired retry window fails closed before another provider send', async () => {
    await db.query("update email_outbox set status='pending' where id=$1",[claimed.id]);
    assert.equal((await db.query('select * from public.claim_confirmed_welcome(1)')).rows.length,0);
    assert.equal((await db.query('select status from email_outbox where id=$1',[claimed.id])).rows[0].status,'failed');
  });
  await test('retry uses a finite backoff and preserves original idempotency window', async () => {
    await db.query("update email_outbox set status='pending',attempts=0,idempotency_started_at=null where id=$1",[claimed.id]);
    claimed=(await db.query('select * from public.claim_confirmed_welcome(1)')).rows[0];
    await db.query("select public.finish_confirmed_welcome($1,$2,'retry',null)",[claimed.id,claimed.lease_id]);
    const row=(await db.query('select status,attempts,scheduled_at>now() as delayed,idempotency_started_at is not null as has_window from email_outbox where id=$1',[claimed.id])).rows[0];
    assert.deepEqual(row,{status:'pending',attempts:1,delayed:true,has_window:true});
    assert.equal((await db.query('select * from public.claim_confirmed_welcome(1)')).rows.length,0);
  });
  await test('maximum third attempt cannot requeue', async () => {
    await db.query("update email_outbox set attempts=2,scheduled_at=now() where id=$1",[claimed.id]);
    claimed=(await db.query('select * from public.claim_confirmed_welcome(1)')).rows[0];
    await db.query("select public.finish_confirmed_welcome($1,$2,'retry',null)",[claimed.id,claimed.lease_id]);
    assert.equal((await db.query('select status from email_outbox where id=$1',[claimed.id])).rows[0].status,'failed');
  });
  await test('invalid batch/outcome and null values fail closed', async () => {
    for (const limit of [0,6,null]) await assert.rejects(db.query('select * from public.claim_confirmed_welcome($1)',[limit]),/invalid_email_batch/);
    await assert.rejects(db.query('select public.finish_confirmed_welcome($1,$2,null,null)',[claimed.id,claimed.lease_id]),/invalid_email_outcome/);
  });
  await test('daily counter includes previous-day event retries and caps total claims', async t => {
    if (new Date().getUTCHours() >= 23) { t.skip('Previous UTC day is outside the 23-hour safe retry window'); return; }
    await db.query("update public.email_delivery_budget set attempts=0 where delivery_date=(now() at time zone 'UTC')::date");
    await db.query(`insert into auth.users(id,email,email_confirmed_at)
      select gen_random_uuid(),'delivered@resend.dev',now() from generate_series(1,12)`);
    // A prior event window is independent of the date when this attempt is made.
    await db.query("update email_outbox set idempotency_started_at=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')-interval '1 millisecond' where attempts=0");
    const other = new Client({...options,database}); await other.connect();
    try {
      const [first,second] = await Promise.all([
        db.query('select * from public.claim_confirmed_welcome(5)'),
        other.query('select * from public.claim_confirmed_welcome(5)'),
      ]);
      assert.equal(first.rows.length+second.rows.length,10);
      assert.equal(new Set([...first.rows,...second.rows].map(row=>row.id)).size,10);
    } finally { await other.end(); }
    assert.equal((await db.query('select * from public.claim_confirmed_welcome(1)')).rows.length,0);
    assert.equal((await db.query("select attempts from email_delivery_budget where delivery_date=(now() at time zone 'UTC')::date")).rows[0].attempts,10);
  });
  await test('client roles cannot read or alter the delivery budget', async () => {
    for (const role of ['anon','authenticated','service_role']) {
      await db.query(`set role ${role}`);
      await assert.rejects(db.query('select * from public.email_delivery_budget'),e=>e.code==='42501');
      await db.query('reset role');
    }
  });
} finally { await db.end(); }

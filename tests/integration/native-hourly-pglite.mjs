import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();
try {
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);");
 for(const name of ['20261003060000_apiwild_gateway_portability.sql','20261005030000_retail_supplier_separation.sql','20261005031735_workspace_policy.sql','20261005032721_nullable_customer_key_limits.sql','20261012193000_gateway_active_concurrency.sql','20261012234347_native_customer_hourly_billing.sql','20261013003000_native_key_name_limit.sql']) {
  await db.exec(fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
 }
 await db.exec(fs.readFileSync(new URL('../../infra/railway/tests/native-hourly-acceptance.sql',import.meta.url),'utf8'));
 for (const table of ['auth.users','apiwild_finance.gateway_accounts','apiwild_finance.gateway_requests','apiwild_finance.native_customer_keys','apiwild_finance.native_usage_receipts']) {
  assert.equal(Number((await db.query(`select count(*) n from ${table}`)).rows[0].n),0,`${table}: fixture rollback retained rows`);
 }
 console.log('PASS: native hourly SQL pricing, rounding, duplicate replay, changed-receipt rejection, unknown-model rejection, NULL fencing, zero-funding rejection, tightened-policy settlement, incomplete-sync protection, exact retail/supplier totals, and complete fixture rollback.');
} finally {await db.close();}

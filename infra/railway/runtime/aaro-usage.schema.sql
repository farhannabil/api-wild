-- UNREGISTERED SOURCE PROPOSAL. No production SQL, accounts, funds, tariffs or keys are installed.
-- Separate AARO subscription units and native CNY liability; legacy API WILD/D1 is untouched.
-- Funding, invoice/region/refund facts must be independently projected/imported by the owner lane.
begin;
create schema if not exists aaro_finance;
revoke all on schema aaro_finance from public,anon,authenticated,service_role;

create table if not exists aaro_finance.accounts (
  owner text primary key,
  customer_id uuid not null references auth.users(id),
  billing_mode text not null check (billing_mode in ('live','test')),
  frozen boolean not null default true,
  check (owner=billing_mode||':supabase:'||customer_id::text)
);
create table if not exists aaro_finance.subscriptions (
  id text primary key check (id ~ '^sub_[A-Za-z0-9]+$'),
  owner text not null references aaro_finance.accounts(owner),
  account_id text not null,
  billing_mode text not null check (billing_mode in ('live','test')),
  plan_reference text not null check (length(plan_reference) between 1 and 160),
  status text not null default 'unaccepted' check (status in ('unaccepted','active','past_due','cancelled','held')),
  projection_receipt_sha256 text check (projection_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  check (account_id=case billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end),
  check (owner like billing_mode||':supabase:%'),
  check (status<>'active' or projection_receipt_sha256 is not null)
);
create table if not exists aaro_finance.credit_periods (
  invoice_id text primary key check (invoice_id ~ '^in_[A-Za-z0-9]+$'),
  subscription_id text not null references aaro_finance.subscriptions(id),
  owner text not null references aaro_finance.accounts(owner),
  credits bigint not null check (credits between 1 and 10000000),
  spent_credits bigint not null default 0 check (spent_credits>=0),
  reserved_credits bigint not null default 0 check (reserved_credits>=0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  paid boolean not null default false,
  frozen boolean not null default true,
  projection_receipt_sha256 text check (projection_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  check (period_end>period_start),
  check (spent_credits+reserved_credits<=credits),
  check (not paid or projection_receipt_sha256 is not null)
);
-- One product allowance across all keys, billing modes and rotations.
create table if not exists aaro_finance.aggregate_budget (
  product text primary key check (product='aaro'),
  total_cap_native_cny_micros bigint not null default 50000000 check (total_cap_native_cny_micros=50000000),
  spent_native_cny_micros bigint not null default 0 check (spent_native_cny_micros>=0),
  reserved_native_cny_micros bigint not null default 0 check (reserved_native_cny_micros>=0),
  observed_excess_native_cny_micros numeric(30,0) not null default 0 check (observed_excess_native_cny_micros>=0),
  accepted boolean not null default false,
  check (spent_native_cny_micros+reserved_native_cny_micros<=total_cap_native_cny_micros),
  check (not accepted or spent_native_cny_micros+reserved_native_cny_micros+observed_excess_native_cny_micros<=total_cap_native_cny_micros)
);
create table if not exists aaro_finance.product_budgets (
  key_reference text primary key check (key_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  product text not null default 'aaro' references aaro_finance.aggregate_budget(product) check (product='aaro'),
  billing_mode text not null check (billing_mode in ('live','test')),
  tariff_version text not null check (tariff_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  acceptance_receipt_sha256 text not null check (acceptance_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  admission_receipt_sha256 text not null check (admission_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  total_cap_native_cny_micros bigint not null default 50000000 check (total_cap_native_cny_micros=50000000),
  max_call_native_cny_micros bigint not null check (max_call_native_cny_micros between 1 and 50000000),
  spent_native_cny_micros bigint not null default 0 check (spent_native_cny_micros>=0),
  reserved_native_cny_micros bigint not null default 0 check (reserved_native_cny_micros>=0),
  accepted boolean not null default false,
  check (spent_native_cny_micros+reserved_native_cny_micros<=total_cap_native_cny_micros)
);
create table if not exists aaro_finance.tariffs (
  version text not null,
  model text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  max_input_tokens bigint not null check (max_input_tokens between 1 and 128000),
  max_output_tokens bigint not null check (max_output_tokens between 1 and 4096),
  input_credits_per_million bigint not null check (input_credits_per_million between 0 and 1000000000000),
  output_credits_per_million bigint not null check (output_credits_per_million between 0 and 1000000000000),
  input_native_cny_micros_per_million bigint not null check (input_native_cny_micros_per_million between 0 and 1000000000000),
  output_native_cny_micros_per_million bigint not null check (output_native_cny_micros_per_million between 0 and 1000000000000),
  accepted boolean not null default false,
  acceptance_receipt_sha256 text not null check (acceptance_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  primary key(version,model)
);
create table if not exists aaro_finance.requests (
  id uuid primary key default gen_random_uuid(),
  owner text not null references aaro_finance.accounts(owner),
  invoice_id text not null references aaro_finance.credit_periods(invoice_id),
  key_reference text not null references aaro_finance.product_budgets(key_reference),
  billing_mode text not null check (billing_mode in ('live','test')),
  request_key text not null,
  binding jsonb not null,
  maximum_credits bigint not null check (maximum_credits between 1 and 1000000),
  maximum_native_cny_micros bigint not null check (maximum_native_cny_micros between 1 and 50000000),
  input_credits_per_million bigint not null,
  output_credits_per_million bigint not null,
  input_native_cny_micros_per_million bigint not null,
  output_native_cny_micros_per_million bigint not null,
  admission_receipt_sha256 text not null,
  state text not null default 'reserved' check (state in ('reserved','executing','uncertain','succeeded','cancelled')),
  actual_credits bigint not null default 0 check (actual_credits>=0),
  actual_native_cny_micros bigint not null default 0 check (actual_native_cny_micros>=0),
  observed_native_cny_micros bigint not null default 0 check (observed_native_cny_micros>=0),
  input_tokens bigint,
  output_tokens bigint,
  provider_request_id text,
  supplier_debit_reference text,
  reconciliation_receipt_sha256 text,
  pricing_bound_exceeded boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '120 seconds',
  unique(owner,request_key),
  unique(key_reference,billing_mode,provider_request_id),
  unique(key_reference,billing_mode,supplier_debit_reference),
  check (actual_credits<=maximum_credits and actual_native_cny_micros<=maximum_native_cny_micros),
  check (state='succeeded' or (actual_credits=0 and actual_native_cny_micros=0)),
  check (not pricing_bound_exceeded or state='uncertain'),
  check (state<>'succeeded' or (provider_request_id is not null and supplier_debit_reference is not null
    and reconciliation_receipt_sha256 is not null and input_tokens is not null and output_tokens is not null))
);
create index if not exists aaro_requests_owner_state on aaro_finance.requests(owner,state);
-- Immutable exact trusted facts; conservative request/budget maxima are not receipt tuples.
create table if not exists aaro_finance.liability_observations (
  request_id uuid not null references aaro_finance.requests(id),
  reconciliation_receipt_sha256 text not null check (reconciliation_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  provider_request_id text not null,
  supplier_debit_reference text not null,
  input_tokens bigint not null check (input_tokens between 1 and 1000000000),
  output_tokens bigint not null check (output_tokens between 0 and 1000000000),
  native_cny_micros bigint not null check (native_cny_micros between 0 and 9007199254740991),
  observed_only boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(request_id,reconciliation_receipt_sha256)
);
create table if not exists aaro_finance.usage_outbox (
  request_id uuid primary key references aaro_finance.requests(id),
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table aaro_finance.accounts enable row level security;
alter table aaro_finance.subscriptions enable row level security;
alter table aaro_finance.credit_periods enable row level security;
alter table aaro_finance.aggregate_budget enable row level security;
alter table aaro_finance.product_budgets enable row level security;
alter table aaro_finance.tariffs enable row level security;
alter table aaro_finance.requests enable row level security;
alter table aaro_finance.liability_observations enable row level security;
alter table aaro_finance.usage_outbox enable row level security;
revoke all on all tables in schema aaro_finance from public,anon,authenticated,service_role;

create or replace function aaro_finance.binding_valid(b jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
  return coalesce(b is not null and jsonb_typeof(b)='object'
    and b ?& array['protocol','product','owner','mode','keyReference','tariffVersion','acceptanceReceiptSHA256','model','requestKey','payloadHash','maximumInputTokens','maximumOutputTokens','totalCapNativeCnyMicros']
    and b-'protocol'-'product'-'owner'-'mode'-'keyReference'-'tariffVersion'-'acceptanceReceiptSHA256'-'model'-'requestKey'-'payloadHash'-'maximumInputTokens'-'maximumOutputTokens'-'totalCapNativeCnyMicros'='{}'::jsonb
    and b->>'protocol'='aaro-subrouter-usage-v1' and b->>'product'='aaro'
    and b->>'mode' in ('live','test')
    and b->>'owner' ~ '^(live|test):supabase:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and b->>'owner' like (b->>'mode')||':supabase:%'
    and b->>'keyReference' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    and b->>'tariffVersion' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    and b->>'acceptanceReceiptSHA256' ~ '^[a-f0-9]{64}$'
    and b->>'model' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
    and b->>'requestKey' ~ '^[A-Za-z0-9_-]{16,80}$' and b->>'payloadHash' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(b->'maximumInputTokens')='number' and b->>'maximumInputTokens' ~ '^[0-9]{1,6}$'
    and (b->>'maximumInputTokens')::bigint between 1 and 128000
    and jsonb_typeof(b->'maximumOutputTokens')='number' and b->>'maximumOutputTokens' ~ '^[0-9]{1,4}$'
    and (b->>'maximumOutputTokens')::bigint between 1 and 4096
    and b->'totalCapNativeCnyMicros'='50000000'::jsonb,false);
exception when others then return false;
end;
$$;
create or replace function aaro_finance.assert_customer(p_owner text) returns void
language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from aaro_finance.accounts a join auth.users u on u.id=a.customer_id
    where a.owner=p_owner and not a.frozen and u.email_confirmed_at is not null and u.is_anonymous=false)
  then raise exception 'aaro_customer_unaccepted'; end if;
end;
$$;
-- Every mutating path uses aggregate -> key -> owner -> period -> request lock order.
create or replace function aaro_finance.lock_request(p_owner text,p_id uuid)
returns aaro_finance.requests language plpgsql set search_path='' as $$
declare r aaro_finance.requests;
begin
  select * into r from aaro_finance.requests where id=p_id and owner=p_owner;
  if not found then raise exception 'aaro_request_not_found'; end if;
  perform 1 from aaro_finance.aggregate_budget where product='aaro' for update;
  perform 1 from aaro_finance.product_budgets where key_reference=r.key_reference for update;
  perform 1 from aaro_finance.accounts where owner=r.owner for update;
  perform 1 from aaro_finance.credit_periods where invoice_id=r.invoice_id for update;
  select * into r from aaro_finance.requests where id=p_id and owner=p_owner for update;
  return r;
end;
$$;

create or replace function public.aaro_usage_reserve_v1(p_owner text,p_binding jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare a aaro_finance.aggregate_budget; b aaro_finance.product_budgets; t aaro_finance.tariffs; p aaro_finance.credit_periods;
  r aaro_finance.requests; v_credits bigint; v_cny bigint; v_now timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'aaro_isolation_unsupported'; end if;
  if not aaro_finance.binding_valid(p_binding) or p_binding->>'owner' is distinct from p_owner then raise exception 'aaro_invalid_binding'; end if;
  select * into a from aaro_finance.aggregate_budget where product='aaro' for update;
  if not found then raise exception 'aaro_budget_unregistered'; end if;
  select * into b from aaro_finance.product_budgets where key_reference=p_binding->>'keyReference' for update;
  if not found then raise exception 'aaro_budget_unregistered'; end if;
  perform 1 from aaro_finance.accounts where owner=p_owner for update;
  perform aaro_finance.assert_customer(p_owner);
  if b.billing_mode<>p_binding->>'mode' or b.tariff_version<>p_binding->>'tariffVersion'
    or b.acceptance_receipt_sha256<>p_binding->>'acceptanceReceiptSHA256' then raise exception 'aaro_budget_binding_mismatch'; end if;
  select * into r from aaro_finance.requests where owner=p_owner and request_key=p_binding->>'requestKey';
  if found then
    if r.binding<>p_binding then raise exception 'aaro_request_conflict'; end if;
    return jsonb_build_object('fresh',false,'record',to_jsonb(r));
  end if;
  if not a.accepted or not b.accepted then raise exception 'aaro_budget_unaccepted'; end if;
  select * into t from aaro_finance.tariffs where version=b.tariff_version and model=p_binding->>'model';
  if not found or not t.accepted or t.acceptance_receipt_sha256<>b.acceptance_receipt_sha256 then raise exception 'aaro_tariff_unaccepted'; end if;
  if (p_binding->>'maximumInputTokens')::bigint>t.max_input_tokens
    or (p_binding->>'maximumOutputTokens')::bigint>t.max_output_tokens then raise exception 'aaro_token_bound_exceeded'; end if;
  v_credits:=greatest(1,ceil(((p_binding->>'maximumInputTokens')::numeric*t.input_credits_per_million
    +(p_binding->>'maximumOutputTokens')::numeric*t.output_credits_per_million)/1000000)::bigint);
  v_cny:=greatest(1,ceil(((p_binding->>'maximumInputTokens')::numeric*t.input_native_cny_micros_per_million
    +(p_binding->>'maximumOutputTokens')::numeric*t.output_native_cny_micros_per_million)/1000000)::bigint);
  if v_credits>1000000 or v_cny>b.max_call_native_cny_micros then raise exception 'aaro_quote_exceeded'; end if;
  if a.spent_native_cny_micros+a.reserved_native_cny_micros+a.observed_excess_native_cny_micros+v_cny>a.total_cap_native_cny_micros
    or b.spent_native_cny_micros+b.reserved_native_cny_micros+v_cny>b.total_cap_native_cny_micros then raise exception 'aaro_native_budget_exhausted'; end if;
  if (select count(*) from aaro_finance.requests where owner=p_owner and state in ('reserved','executing','uncertain'))>=2
    then raise exception 'aaro_concurrent_limit'; end if;
  v_now:=clock_timestamp();
  select p0.* into p from aaro_finance.credit_periods p0 join aaro_finance.subscriptions s on s.id=p0.subscription_id
    where p0.owner=p_owner and s.owner=p_owner and s.billing_mode=p_binding->>'mode' and s.status='active'
      and p0.paid and not p0.frozen and p0.period_start<=v_now and p0.period_end>v_now
      and p0.credits-p0.spent_credits-p0.reserved_credits>=v_credits
    order by p0.period_end,p0.invoice_id limit 1 for update of p0;
  if not found then raise exception 'aaro_credits_insufficient'; end if;
  insert into aaro_finance.requests(owner,invoice_id,key_reference,billing_mode,request_key,binding,maximum_credits,
    maximum_native_cny_micros,input_credits_per_million,output_credits_per_million,input_native_cny_micros_per_million,output_native_cny_micros_per_million,admission_receipt_sha256)
    values(p_owner,p.invoice_id,b.key_reference,b.billing_mode,p_binding->>'requestKey',p_binding,v_credits,v_cny,
      t.input_credits_per_million,t.output_credits_per_million,t.input_native_cny_micros_per_million,t.output_native_cny_micros_per_million,b.admission_receipt_sha256) returning * into r;
  update aaro_finance.credit_periods set reserved_credits=reserved_credits+v_credits where invoice_id=p.invoice_id;
  update aaro_finance.aggregate_budget set reserved_native_cny_micros=reserved_native_cny_micros+v_cny where product='aaro';
  update aaro_finance.product_budgets set reserved_native_cny_micros=reserved_native_cny_micros+v_cny where key_reference=b.key_reference;
  return jsonb_build_object('fresh',true,'record',to_jsonb(r));
end;
$$;
create or replace function public.aaro_usage_read_v1(p_owner text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r aaro_finance.requests;
begin
  select * into r from aaro_finance.requests where owner=p_owner and id=p_id;
  if not found then raise exception 'aaro_request_not_found'; end if;
  return jsonb_build_object('record',to_jsonb(r));
end;
$$;
create or replace function public.aaro_usage_claim_v1(p_owner text,p_id uuid,p_binding jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r aaro_finance.requests; v_now timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'aaro_isolation_unsupported'; end if;
  r:=aaro_finance.lock_request(p_owner,p_id);
  if not aaro_finance.binding_valid(p_binding) or r.binding<>p_binding then raise exception 'aaro_request_conflict'; end if;
  if r.state<>'reserved' then return jsonb_build_object('claimed',false,'record',to_jsonb(r)); end if;
  perform aaro_finance.assert_customer(p_owner); v_now:=clock_timestamp();
  if r.expires_at<=v_now or not exists(select 1 from aaro_finance.aggregate_budget where product='aaro' and accepted
      and spent_native_cny_micros+reserved_native_cny_micros+observed_excess_native_cny_micros<=total_cap_native_cny_micros)
    or not exists(select 1 from aaro_finance.product_budgets b where b.key_reference=r.key_reference and b.accepted
      and b.billing_mode=r.billing_mode and b.tariff_version=r.binding->>'tariffVersion'
      and b.acceptance_receipt_sha256=r.binding->>'acceptanceReceiptSHA256' and b.admission_receipt_sha256=r.admission_receipt_sha256
      and b.max_call_native_cny_micros>=r.maximum_native_cny_micros)
    or not exists(select 1 from aaro_finance.tariffs t where t.version=r.binding->>'tariffVersion' and t.model=r.binding->>'model' and t.accepted
      and t.acceptance_receipt_sha256=r.binding->>'acceptanceReceiptSHA256'
      and t.input_credits_per_million=r.input_credits_per_million and t.output_credits_per_million=r.output_credits_per_million
      and t.input_native_cny_micros_per_million=r.input_native_cny_micros_per_million and t.output_native_cny_micros_per_million=r.output_native_cny_micros_per_million
      and t.max_input_tokens>=(r.binding->>'maximumInputTokens')::bigint and t.max_output_tokens>=(r.binding->>'maximumOutputTokens')::bigint)
    or not exists(select 1 from aaro_finance.credit_periods p join aaro_finance.subscriptions s on s.id=p.subscription_id
      where p.invoice_id=r.invoice_id and p.owner=p_owner and s.owner=p_owner and s.status='active'
      and p.paid and not p.frozen and p.period_start<=v_now and p.period_end>v_now)
    then raise exception 'aaro_claim_unaccepted'; end if;
  update aaro_finance.requests set state='executing',updated_at=clock_timestamp() where id=r.id returning * into r;
  return jsonb_build_object('claimed',true,'record',to_jsonb(r));
end;
$$;
create or replace function public.aaro_usage_settle_v1(p_owner text,p_id uuid,p_binding jsonb,p_fact jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r aaro_finance.requests; v_credits numeric; v_cny bigint; v_input bigint; v_output bigint; v_excess bigint; o aaro_finance.liability_observations;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'aaro_isolation_unsupported'; end if;
  if p_fact is null or jsonb_typeof(p_fact)<>'object'
    or not p_fact ?& array['providerRequestId','inputTokens','outputTokens','actualNativeCnyMicros','supplierDebitReference','reconciliationReceiptSHA256','observedOnly']
    or p_fact-'providerRequestId'-'inputTokens'-'outputTokens'-'actualNativeCnyMicros'-'supplierDebitReference'-'reconciliationReceiptSHA256'-'observedOnly'<>'{}'::jsonb
    or jsonb_typeof(p_fact->'observedOnly')<>'boolean'
    or jsonb_typeof(p_fact->'providerRequestId')<>'string' or jsonb_typeof(p_fact->'supplierDebitReference')<>'string' or jsonb_typeof(p_fact->'reconciliationReceiptSHA256')<>'string'
    or p_fact->>'providerRequestId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or p_fact->>'supplierDebitReference' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or p_fact->>'reconciliationReceiptSHA256' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_fact->'inputTokens')<>'number' or p_fact->>'inputTokens' !~ '^[0-9]{1,10}$'
    or jsonb_typeof(p_fact->'outputTokens')<>'number' or p_fact->>'outputTokens' !~ '^[0-9]{1,10}$'
    or jsonb_typeof(p_fact->'actualNativeCnyMicros')<>'number' or p_fact->>'actualNativeCnyMicros' !~ '^[0-9]{1,16}$'
    then raise exception 'aaro_invalid_settlement'; end if;
  v_input:=(p_fact->>'inputTokens')::bigint; v_output:=(p_fact->>'outputTokens')::bigint;
  v_cny:=(p_fact->>'actualNativeCnyMicros')::bigint;
  if v_cny>9007199254740991 then raise exception 'aaro_invalid_settlement'; end if;
  r:=aaro_finance.lock_request(p_owner,p_id);
  if not aaro_finance.binding_valid(p_binding) or r.binding<>p_binding then raise exception 'aaro_request_conflict'; end if;
  -- These are independently verified observations, never caller claims.
  if v_input not between 1 and 1000000000 or v_output not between 0 and 1000000000 then raise exception 'aaro_invalid_settlement'; end if;
  v_credits:=ceil((v_input::numeric*r.input_credits_per_million+v_output::numeric*r.output_credits_per_million)/1000000);
  if r.state='succeeded' then
    if r.input_tokens=v_input and r.output_tokens=v_output and r.actual_native_cny_micros=v_cny
      and r.provider_request_id=p_fact->>'providerRequestId' and r.supplier_debit_reference=p_fact->>'supplierDebitReference'
      and r.reconciliation_receipt_sha256=p_fact->>'reconciliationReceiptSHA256'
      then return jsonb_build_object('settled',true,'replayed',true,'record',to_jsonb(r)); end if;
    raise exception 'aaro_settlement_conflict';
  end if;
  if r.state not in ('executing','uncertain') then raise exception 'aaro_request_unclaimed'; end if;
  if (r.provider_request_id is not null and r.provider_request_id<>p_fact->>'providerRequestId')
    or (r.supplier_debit_reference is not null and r.supplier_debit_reference<>p_fact->>'supplierDebitReference')
    then raise exception 'aaro_settlement_conflict'; end if;
  select * into o from aaro_finance.liability_observations where request_id=r.id and reconciliation_receipt_sha256=p_fact->>'reconciliationReceiptSHA256';
  if found then
    if o.provider_request_id<>p_fact->>'providerRequestId' or o.supplier_debit_reference<>p_fact->>'supplierDebitReference'
      or o.input_tokens<>v_input or o.output_tokens<>v_output or o.native_cny_micros<>v_cny or o.observed_only<>(p_fact->>'observedOnly')::boolean
      then raise exception 'aaro_settlement_conflict'; end if;
  else
    insert into aaro_finance.liability_observations(request_id,reconciliation_receipt_sha256,provider_request_id,supplier_debit_reference,input_tokens,output_tokens,native_cny_micros,observed_only)
      values(r.id,p_fact->>'reconciliationReceiptSHA256',p_fact->>'providerRequestId',p_fact->>'supplierDebitReference',v_input,v_output,v_cny,(p_fact->>'observedOnly')::boolean);
  end if;
  if r.pricing_bound_exceeded or (p_fact->>'observedOnly')::boolean or v_cny>r.maximum_native_cny_micros or v_credits>r.maximum_credits
    or v_input>(r.binding->>'maximumInputTokens')::bigint or v_output>(r.binding->>'maximumOutputTokens')::bigint then
    -- Commit the freeze/observed liability: throwing would roll them back.
    v_excess:=greatest(0,greatest(r.observed_native_cny_micros,v_cny)-r.maximum_native_cny_micros)-greatest(0,r.observed_native_cny_micros-r.maximum_native_cny_micros);
    update aaro_finance.aggregate_budget set accepted=false,observed_excess_native_cny_micros=observed_excess_native_cny_micros+v_excess where product='aaro';
    update aaro_finance.product_budgets set accepted=false where key_reference=r.key_reference;
    update aaro_finance.credit_periods set frozen=true where invoice_id=r.invoice_id;
    update aaro_finance.requests set state='uncertain',pricing_bound_exceeded=true,
      observed_native_cny_micros=greatest(observed_native_cny_micros,v_cny),input_tokens=v_input,
      output_tokens=v_output,provider_request_id=p_fact->>'providerRequestId',
      supplier_debit_reference=p_fact->>'supplierDebitReference',reconciliation_receipt_sha256=p_fact->>'reconciliationReceiptSHA256',updated_at=clock_timestamp()
      where id=r.id returning * into r;
    return jsonb_build_object('settled',false,'record',to_jsonb(r));
  end if;
  update aaro_finance.requests set state='succeeded',actual_credits=v_credits,actual_native_cny_micros=v_cny,
    observed_native_cny_micros=v_cny,input_tokens=v_input,output_tokens=v_output,provider_request_id=p_fact->>'providerRequestId',
    supplier_debit_reference=p_fact->>'supplierDebitReference',reconciliation_receipt_sha256=p_fact->>'reconciliationReceiptSHA256',
    updated_at=clock_timestamp() where id=r.id returning * into r;
  update aaro_finance.credit_periods set reserved_credits=reserved_credits-r.maximum_credits,spent_credits=spent_credits+v_credits where invoice_id=r.invoice_id;
  update aaro_finance.aggregate_budget set reserved_native_cny_micros=reserved_native_cny_micros-r.maximum_native_cny_micros,
    spent_native_cny_micros=spent_native_cny_micros+v_cny where product='aaro';
  update aaro_finance.product_budgets set reserved_native_cny_micros=reserved_native_cny_micros-r.maximum_native_cny_micros,
    spent_native_cny_micros=spent_native_cny_micros+v_cny where key_reference=r.key_reference;
  insert into aaro_finance.usage_outbox(request_id,payload) values(r.id,jsonb_build_object('protocol','aaro-subrouter-usage-v1',
    'product','aaro','owner',r.owner,'invoiceId',r.invoice_id,'actualCredits',r.actual_credits,'nativeCurrency','CNY',
    'actualNativeCnyMicros',r.actual_native_cny_micros,'supplierDebitReference',r.supplier_debit_reference,
    'reconciliationReceiptSHA256',r.reconciliation_receipt_sha256));
  return jsonb_build_object('settled',true,'replayed',false,'record',to_jsonb(r));
end;
$$;
create or replace function public.aaro_usage_uncertain_v1(p_owner text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r aaro_finance.requests;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'aaro_isolation_unsupported'; end if;
  r:=aaro_finance.lock_request(p_owner,p_id);
  if r.state='executing' then update aaro_finance.requests set state='uncertain',updated_at=clock_timestamp() where id=r.id returning * into r; end if;
  return jsonb_build_object('held',r.state in ('reserved','executing','uncertain'),'record',to_jsonb(r));
end;
$$;
-- Cancellation is service-only and restricted to expired, NEVER CLAIMED work.
-- There is no customer failed/release action or refund based on an HTTP status.
create or replace function public.aaro_usage_expire_v1(p_owner text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r aaro_finance.requests;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'aaro_isolation_unsupported'; end if;
  r:=aaro_finance.lock_request(p_owner,p_id);
  if r.state='cancelled' then return jsonb_build_object('cancelled',true,'replayed',true,'record',to_jsonb(r)); end if;
  if r.state<>'reserved' or r.expires_at>clock_timestamp() then return jsonb_build_object('cancelled',false,'record',to_jsonb(r)); end if;
  update aaro_finance.requests set state='cancelled',updated_at=clock_timestamp() where id=r.id returning * into r;
  update aaro_finance.credit_periods set reserved_credits=reserved_credits-r.maximum_credits where invoice_id=r.invoice_id;
  update aaro_finance.aggregate_budget set reserved_native_cny_micros=reserved_native_cny_micros-r.maximum_native_cny_micros where product='aaro';
  update aaro_finance.product_budgets set reserved_native_cny_micros=reserved_native_cny_micros-r.maximum_native_cny_micros where key_reference=r.key_reference;
  return jsonb_build_object('cancelled',true,'replayed',false,'record',to_jsonb(r));
end;
$$;
revoke all on all functions in schema aaro_finance from public,anon,authenticated,service_role;
revoke all on function public.aaro_usage_reserve_v1(text,jsonb) from public,anon,authenticated;
revoke all on function public.aaro_usage_read_v1(text,uuid) from public,anon,authenticated;
revoke all on function public.aaro_usage_claim_v1(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.aaro_usage_settle_v1(text,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.aaro_usage_uncertain_v1(text,uuid) from public,anon,authenticated;
revoke all on function public.aaro_usage_expire_v1(text,uuid) from public,anon,authenticated;
grant execute on function public.aaro_usage_reserve_v1(text,jsonb),public.aaro_usage_read_v1(text,uuid),
  public.aaro_usage_claim_v1(text,uuid,jsonb),public.aaro_usage_settle_v1(text,uuid,jsonb,jsonb),
  public.aaro_usage_uncertain_v1(text,uuid),public.aaro_usage_expire_v1(text,uuid) to service_role;
commit;

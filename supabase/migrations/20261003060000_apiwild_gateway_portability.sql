-- OFFLINE SOURCE PREPARATION ONLY. This is not an applied balance migration.
-- Requires the existing Supabase auth.users/customer_profiles foundation.
-- No accounts, accepted budgets, provider keys, prices or entitlements are seeded.
-- Privileged configuration/import changes require a quiescent gateway and the
-- same provider -> owner -> key -> request lock order. Service RPC callers have
-- no direct table privileges. Aggregate admission requires READ COMMITTED.
-- funded_usd_micros/payment_hold_usd_micros are future verified-ledger projections,
-- NOT a replacement for Stripe event/credit/refund/dispute reconciliation.
-- Supplier CNY bounds are separate from customer USD quotes. A receipt string is
-- an audit reference supplied by a trusted server, NOT proof of a seller debit.
begin;

create schema if not exists apiwild_finance;
revoke all on schema apiwild_finance from public, anon, authenticated, service_role;

create table if not exists apiwild_finance.gateway_accounts (
  user_id text primary key,
  customer_id uuid not null references auth.users(id),
  billing_mode text not null check (billing_mode in ('live','test')),
  funded_usd_micros bigint not null default 0 check (funded_usd_micros between -1000000000000 and 1000000000000),
  payment_hold_usd_micros bigint not null default 0 check (payment_hold_usd_micros between 0 and 1000000000000),
  daily_limit_usd_micros bigint not null default 10000000 check (daily_limit_usd_micros between 0 and 1000000000000),
  suspended boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  check (user_id = billing_mode || ':supabase:' || customer_id::text)
);
create index if not exists pg_gateway_accounts_customer on apiwild_finance.gateway_accounts(customer_id);

create table if not exists apiwild_finance.provider_budgets (
  id uuid primary key,
  product text not null check (product = 'apiwild'),
  billing_mode text not null check (billing_mode in ('live','test')),
  currency text not null default 'CNY' check (currency = 'CNY'),
  -- Never store a raw supplier credential here. This is an opaque operator ID.
  key_reference uuid not null unique,
  accepted boolean not null default false,
  total_limit_cny_micros bigint not null check (total_limit_cny_micros between 0 and 50000000),
  daily_limit_cny_micros bigint not null check (daily_limit_cny_micros between 0 and 50000000),
  rate_version text not null check (length(rate_version) between 1 and 160),
  models text[] not null check (cardinality(models) between 1 and 32 and array_position(models,null) is null)
);

create table if not exists apiwild_finance.gateway_keys (
  id uuid primary key,
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  hash text not null unique check (hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 6 and array_position(scopes,null) is null
    and scopes <@ array['chat','code','research','voice','transcribe','speak']::text[]),
  daily_limit_usd_micros bigint not null check (daily_limit_usd_micros between 0 and 1000000000000),
  total_limit_usd_micros bigint not null check (total_limit_usd_micros between 0 and 1000000000000),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique(id,user_id)
);
create index if not exists pg_gateway_keys_owner on apiwild_finance.gateway_keys(user_id);

create table if not exists apiwild_finance.gateway_requests (
  id uuid primary key,
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  key_id uuid,
  provider_budget_id uuid not null references apiwild_finance.provider_budgets(id),
  request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  capability text not null check (capability in ('chat','code','research','voice','transcribe','speak')),
  model text not null check (length(model) between 1 and 160),
  rate_version text not null check (length(rate_version) between 1 and 160),
  state text not null check (state in ('reserved','executing','uncertain','succeeded','failed','cancelled')),
  version bigint not null default 0 check (version between 0 and 9007199254740991),
  reserved_usd_micros bigint not null check (reserved_usd_micros between 1 and 1000000000000),
  cost_usd_micros bigint not null default 0 check (cost_usd_micros between 0 and reserved_usd_micros),
  reserved_cny_micros bigint not null check (reserved_cny_micros between 1 and 50000000),
  cost_cny_micros bigint not null default 0 check (cost_cny_micros between 0 and reserved_cny_micros),
  observed_cny_micros bigint not null default 0 check (observed_cny_micros between 0 and 1000000000000),
  pricing_bound_exceeded boolean not null default false,
  settlement_reference text,
  result_json jsonb,
  usage_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  unique(user_id,request_key),
  foreign key(key_id,user_id) references apiwild_finance.gateway_keys(id,user_id),
  check (octet_length(usage_json::text) <= 65536),
  check (result_json is null or octet_length(result_json::text) <= 1048576),
  check (settlement_reference is null or length(settlement_reference) between 1 and 500),
  check (state <> 'failed' or cost_usd_micros = 0)
);
create index if not exists pg_gateway_requests_owner_date on apiwild_finance.gateway_requests(user_id,created_at);
create index if not exists pg_gateway_requests_key on apiwild_finance.gateway_requests(key_id);
create index if not exists pg_gateway_requests_provider on apiwild_finance.gateway_requests(provider_budget_id,updated_at);
create index if not exists pg_gateway_requests_state on apiwild_finance.gateway_requests(state,updated_at);

create table if not exists apiwild_finance.gateway_outbox (
  request_id uuid primary key references apiwild_finance.gateway_requests(id),
  payload jsonb not null check (octet_length(payload::text) <= 131072),
  created_at timestamptz not null default clock_timestamp()
);

alter table apiwild_finance.gateway_accounts enable row level security;
alter table apiwild_finance.provider_budgets enable row level security;
alter table apiwild_finance.gateway_keys enable row level security;
alter table apiwild_finance.gateway_requests enable row level security;
alter table apiwild_finance.gateway_outbox enable row level security;
revoke all on all tables in schema apiwild_finance from public, anon, authenticated, service_role;

-- Called only inside the definer RPCs, never directly by a customer.
create or replace function apiwild_finance.assert_customer(p_owner text)
returns void language plpgsql set search_path = '' as $$
begin
  if p_owner is null or not exists (
    select 1 from apiwild_finance.gateway_accounts a
      join auth.users u on u.id=a.customer_id
      join public.customer_profiles p on p.user_id=u.id
    where a.user_id=p_owner and not a.suspended and u.email_confirmed_at is not null
      and u.is_anonymous is false and p.onboarding_completed_at is not null
  ) then raise exception 'gateway_customer_unavailable'; end if;
end;
$$;
revoke all on function apiwild_finance.assert_customer(text) from public, anon, authenticated, service_role;

-- All operations acquire locks in the SAME order: provider -> owner -> key -> request.
-- No HTTP/provider call belongs in any of these transactions.
create or replace function public.apiwild_gateway_reserve(
  p_owner text, p_key_id uuid, p_provider_budget_id uuid, p_request_key text,
  p_payload_hash text, p_capability text, p_model text, p_rate_version text,
  p_reserved_usd_micros bigint, p_reserved_cny_micros bigint
) returns jsonb language plpgsql security definer set search_path = ''
  set lock_timeout = '5s' set statement_timeout = '20s' as $$
declare
  b apiwild_finance.provider_budgets;
  a apiwild_finance.gateway_accounts;
  k apiwild_finance.gateway_keys;
  r apiwild_finance.gateway_requests;
  v_usd numeric; v_daily numeric; v_key_total numeric; v_key_daily numeric;
  v_cny numeric; v_cny_daily numeric; v_held bigint; v_minute bigint;
  v_now timestamptz;
  v_day timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'gateway_isolation_unsupported'; end if;
  if p_owner is null or p_provider_budget_id is null or p_request_key is null
    or p_request_key !~ '^[A-Za-z0-9_-]{16,100}$'
    or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_capability is null or p_capability not in ('chat','code','research','voice','transcribe','speak')
    or p_model is null or length(p_model) not between 1 and 160
    or p_rate_version is null or length(p_rate_version) not between 1 and 160
    or p_reserved_usd_micros is null or p_reserved_usd_micros not between 1 and 1000000000000
    or p_reserved_cny_micros is null or p_reserved_cny_micros not between 1 and 50000000
  then raise exception 'gateway_invalid_reservation'; end if;
  select * into b from apiwild_finance.provider_budgets where id=p_provider_budget_id for update;
  if not found then raise exception 'gateway_provider_unavailable'; end if;
  select * into a from apiwild_finance.gateway_accounts where user_id=p_owner for update;
  if not found then raise exception 'gateway_customer_unavailable'; end if;
  if p_key_id is not null then
    select * into k from apiwild_finance.gateway_keys where id=p_key_id for update;
    if not found then raise exception 'gateway_key_unavailable'; end if;
  end if;
  -- Lock waits may cross an expiry, UTC midnight or the one-minute window.
  v_now:=clock_timestamp();
  v_day:=(date_trunc('day',v_now at time zone 'UTC') at time zone 'UTC');
  perform apiwild_finance.assert_customer(p_owner);
  if not b.accepted or b.billing_mode<>a.billing_mode or b.product<>'apiwild'
    or b.currency<>'CNY' or b.rate_version<>p_rate_version or not p_model=any(b.models)
  then raise exception 'gateway_provider_unavailable'; end if;
  if p_key_id is not null and (k.user_id<>p_owner or k.revoked_at is not null or k.expires_at<=v_now
    or not p_capability=any(k.scopes)) then raise exception 'gateway_key_unavailable'; end if;
  select * into r from apiwild_finance.gateway_requests where user_id=p_owner and request_key=p_request_key for update;
  if found then
    if r.key_id is distinct from p_key_id or r.provider_budget_id<>p_provider_budget_id
      or r.payload_hash<>p_payload_hash or r.capability<>p_capability or r.model<>p_model
      or r.rate_version<>p_rate_version or r.reserved_usd_micros<>p_reserved_usd_micros
      or r.reserved_cny_micros<>p_reserved_cny_micros
    then raise exception 'gateway_idempotency_conflict'; end if;
    return jsonb_build_object('fresh',false,'record',to_jsonb(r));
  end if;
  select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
    coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0),
    count(*) filter (where state in ('reserved','executing','uncertain')),
    count(*) filter (where created_at>v_now-interval '1 minute')
    into v_usd,v_daily,v_held,v_minute from apiwild_finance.gateway_requests where user_id=p_owner;
  if v_usd+p_reserved_usd_micros>a.funded_usd_micros-a.payment_hold_usd_micros
    or v_daily+p_reserved_usd_micros>a.daily_limit_usd_micros or v_held>=2 or v_minute>=20
  then raise exception 'gateway_customer_limit'; end if;
  if p_key_id is not null then
    select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
      coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0)
      into v_key_total,v_key_daily from apiwild_finance.gateway_requests where key_id=p_key_id;
    if v_key_total+p_reserved_usd_micros>k.total_limit_usd_micros or v_key_daily+p_reserved_usd_micros>k.daily_limit_usd_micros
    then raise exception 'gateway_key_limit'; end if;
  end if;
  select coalesce(sum(case when state in ('reserved','executing','uncertain') then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end),0),
    coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then case when state in ('reserved','executing','uncertain') then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end else 0 end),0)
    into v_cny,v_cny_daily from apiwild_finance.gateway_requests where provider_budget_id=p_provider_budget_id;
  if v_cny+p_reserved_cny_micros>b.total_limit_cny_micros or v_cny_daily+p_reserved_cny_micros>b.daily_limit_cny_micros
  then raise exception 'gateway_provider_limit'; end if;
  insert into apiwild_finance.gateway_requests(id,user_id,key_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,expires_at)
    values(gen_random_uuid(),p_owner,p_key_id,p_provider_budget_id,p_request_key,p_payload_hash,p_capability,p_model,p_rate_version,'reserved',p_reserved_usd_micros,p_reserved_cny_micros,v_now+interval '2 minutes') returning * into r;
  return jsonb_build_object('fresh',true,'record',to_jsonb(r));
end;
$$;

-- Owner-scoped metadata is read before locking solely to establish lock order.
create or replace function apiwild_finance.lock_request(p_owner text,p_id uuid)
returns apiwild_finance.gateway_requests language plpgsql set search_path = '' as $$
declare r apiwild_finance.gateway_requests;
begin
  if p_owner is null or p_id is null then raise exception 'gateway_invalid_reference'; end if;
  select * into r from apiwild_finance.gateway_requests where id=p_id and user_id=p_owner;
  if not found then raise exception 'gateway_request_not_found'; end if;
  perform 1 from apiwild_finance.provider_budgets where id=r.provider_budget_id for update;
  perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
  if r.key_id is not null then perform 1 from apiwild_finance.gateway_keys where id=r.key_id for update; end if;
  select * into r from apiwild_finance.gateway_requests where id=p_id and user_id=p_owner for update;
  if not found then raise exception 'gateway_request_not_found'; end if;
  return r;
end;
$$;
revoke all on function apiwild_finance.lock_request(text,uuid) from public, anon, authenticated, service_role;

create or replace function public.apiwild_gateway_claim(p_owner text,p_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = ''
  set lock_timeout = '5s' set statement_timeout = '20s' as $$
declare
  r apiwild_finance.gateway_requests; b apiwild_finance.provider_budgets;
  a apiwild_finance.gateway_accounts; k apiwild_finance.gateway_keys;
  v_used numeric; v_daily numeric; v_key_total numeric; v_key_daily numeric;
  v_cny numeric; v_cny_daily numeric;
  v_day timestamptz;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'gateway_isolation_unsupported'; end if;
  if p_expected_version is null or p_expected_version not between 0 and 9007199254740991 then raise exception 'gateway_invalid_version'; end if;
  r:=apiwild_finance.lock_request(p_owner,p_id);
  v_day:=(date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC');
  if r.state<>'reserved' or r.version<>p_expected_version or r.expires_at<=clock_timestamp() then return jsonb_build_object('claimed',false,'record',to_jsonb(r)); end if;
  perform apiwild_finance.assert_customer(p_owner);
  select * into b from apiwild_finance.provider_budgets where id=r.provider_budget_id;
  select * into a from apiwild_finance.gateway_accounts where user_id=p_owner;
  if not b.accepted or b.billing_mode<>a.billing_mode or b.rate_version<>r.rate_version or not r.model=any(b.models) then raise exception 'gateway_provider_unavailable'; end if;
  if r.key_id is not null then
    select * into k from apiwild_finance.gateway_keys where id=r.key_id;
    if k.user_id<>p_owner or k.revoked_at is not null or k.expires_at<=clock_timestamp() or not r.capability=any(k.scopes) then raise exception 'gateway_key_unavailable'; end if;
  end if;
  select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
    coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0)
    into v_used,v_daily from apiwild_finance.gateway_requests where user_id=p_owner;
  if v_used>a.funded_usd_micros-a.payment_hold_usd_micros or v_daily>a.daily_limit_usd_micros then raise exception 'gateway_customer_limit'; end if;
  if r.key_id is not null then
    select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
      coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0)
      into v_key_total,v_key_daily from apiwild_finance.gateway_requests where key_id=r.key_id;
    if v_key_total>k.total_limit_usd_micros or v_key_daily>k.daily_limit_usd_micros then raise exception 'gateway_key_limit'; end if;
  end if;
  select coalesce(sum(case when state in ('reserved','executing','uncertain') then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end),0),
    coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then case when state in ('reserved','executing','uncertain') then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end else 0 end),0)
    into v_cny,v_cny_daily from apiwild_finance.gateway_requests where provider_budget_id=r.provider_budget_id;
  if v_cny>b.total_limit_cny_micros or v_cny_daily>b.daily_limit_cny_micros then raise exception 'gateway_provider_limit'; end if;
  update apiwild_finance.gateway_requests set state='executing',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
  return jsonb_build_object('claimed',true,'record',to_jsonb(r));
end;
$$;

create or replace function public.apiwild_gateway_finish(
  p_owner text,p_id uuid,p_expected_version bigint,p_state text,p_cost_usd_micros bigint,
  p_cost_cny_micros bigint,p_settlement_reference text,p_result jsonb,p_usage jsonb
) returns jsonb language plpgsql security definer set search_path = ''
  set lock_timeout = '5s' set statement_timeout = '20s' as $$
declare r apiwild_finance.gateway_requests;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'gateway_isolation_unsupported'; end if;
  if p_expected_version is null or p_expected_version not between 0 and 9007199254740991
    or p_state is null or p_state not in ('succeeded','failed')
    or p_cost_usd_micros is null or p_cost_usd_micros not between 0 and 1000000000000
    or p_cost_cny_micros is null or p_cost_cny_micros not between 0 and 1000000000000
    or p_settlement_reference is null or length(p_settlement_reference) not between 1 and 500
    or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>1048576
    or p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(p_usage::text)>65536
    or (p_state='failed' and p_cost_usd_micros<>0)
  then raise exception 'gateway_invalid_settlement'; end if;
  r:=apiwild_finance.lock_request(p_owner,p_id);
  if r.state in ('succeeded','failed') then
    if r.state=p_state and r.cost_usd_micros=p_cost_usd_micros and r.cost_cny_micros=p_cost_cny_micros
      and r.settlement_reference=p_settlement_reference and r.result_json=p_result and r.usage_json=p_usage
    then return jsonb_build_object('settled',true,'replayed',true,'record',to_jsonb(r)); end if;
    raise exception 'gateway_settlement_conflict';
  end if;
  if r.state not in ('executing','uncertain') or r.version<>p_expected_version then raise exception 'gateway_stale_settlement'; end if;
  if r.pricing_bound_exceeded then return jsonb_build_object('settled',false,'code','gateway_pricing_reconciliation_required','record',to_jsonb(r)); end if;
  if p_cost_usd_micros>r.reserved_usd_micros or p_cost_cny_micros>r.reserved_cny_micros then
    -- Do NOT throw: rollback would undo this freeze and hide known liability.
    -- The caller must treat settled=false as failure, never as a usable answer.
    update apiwild_finance.provider_budgets set accepted=false where id=r.provider_budget_id;
    update apiwild_finance.gateway_requests set state='uncertain',pricing_bound_exceeded=true,
      observed_cny_micros=greatest(observed_cny_micros,p_cost_cny_micros),settlement_reference=p_settlement_reference,
      version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
    return jsonb_build_object('settled',false,'code','gateway_settlement_exceeds_reservation','record',to_jsonb(r));
  end if;
  update apiwild_finance.gateway_requests set state=p_state,cost_usd_micros=p_cost_usd_micros,cost_cny_micros=p_cost_cny_micros,
    observed_cny_micros=p_cost_cny_micros,settlement_reference=p_settlement_reference,result_json=p_result,usage_json=p_usage,version=version+1,updated_at=clock_timestamp()
    where id=p_id returning * into r;
  insert into apiwild_finance.gateway_outbox(request_id,payload)
    values(r.id,jsonb_build_object('event_type','apiwild.usage','request_id',r.id,'owner',r.user_id,'state',r.state,
      'rate_version',r.rate_version,'customer_currency','USD','cost_usd_micros',r.cost_usd_micros,
      'provider_currency','CNY','cost_cny_micros',r.cost_cny_micros,'settlement_reference',r.settlement_reference,'usage',r.usage_json));
  return jsonb_build_object('settled',true,'replayed',false,'record',to_jsonb(r));
end;
$$;

create or replace function public.apiwild_gateway_uncertain(p_owner text,p_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = ''
  set lock_timeout = '5s' set statement_timeout = '20s' as $$
declare r apiwild_finance.gateway_requests;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'gateway_isolation_unsupported'; end if;
  if p_expected_version is null or p_expected_version not between 0 and 9007199254740991 then raise exception 'gateway_invalid_version'; end if;
  r:=apiwild_finance.lock_request(p_owner,p_id);
  if r.state='uncertain' then return jsonb_build_object('replayed',true,'record',to_jsonb(r)); end if;
  if r.state<>'executing' or r.version<>p_expected_version then raise exception 'gateway_stale_uncertain'; end if;
  update apiwild_finance.gateway_requests set state='uncertain',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
  return jsonb_build_object('replayed',false,'record',to_jsonb(r));
end;
$$;

-- Single-row, bounded cleanup for expired NEVER-DISPATCHED work only. It cannot
-- cancel executing/uncertain work or release an ambiguous supplier liability.
create or replace function public.apiwild_gateway_expire(p_owner text,p_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = ''
  set lock_timeout = '5s' set statement_timeout = '20s' as $$
declare r apiwild_finance.gateway_requests;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'gateway_isolation_unsupported'; end if;
  if p_expected_version is null or p_expected_version not between 0 and 9007199254740991 then raise exception 'gateway_invalid_version'; end if;
  r:=apiwild_finance.lock_request(p_owner,p_id);
  if r.state<>'reserved' or r.version<>p_expected_version or r.expires_at>clock_timestamp()
    then return jsonb_build_object('cancelled',false,'record',to_jsonb(r)); end if;
  update apiwild_finance.gateway_requests set state='cancelled',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
  return jsonb_build_object('cancelled',true,'record',to_jsonb(r));
end;
$$;

revoke all on function public.apiwild_gateway_reserve(text,uuid,uuid,text,text,text,text,text,bigint,bigint) from public, anon, authenticated;
revoke all on function public.apiwild_gateway_claim(text,uuid,bigint) from public, anon, authenticated;
revoke all on function public.apiwild_gateway_finish(text,uuid,bigint,text,bigint,bigint,text,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.apiwild_gateway_uncertain(text,uuid,bigint) from public, anon, authenticated;
revoke all on function public.apiwild_gateway_expire(text,uuid,bigint) from public, anon, authenticated;
grant execute on function public.apiwild_gateway_reserve(text,uuid,uuid,text,text,text,text,text,bigint,bigint) to service_role;
grant execute on function public.apiwild_gateway_claim(text,uuid,bigint) to service_role;
grant execute on function public.apiwild_gateway_finish(text,uuid,bigint,text,bigint,bigint,text,jsonb,jsonb) to service_role;
grant execute on function public.apiwild_gateway_uncertain(text,uuid,bigint) to service_role;
grant execute on function public.apiwild_gateway_expire(text,uuid,bigint) to service_role;
commit;

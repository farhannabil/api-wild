-- Additive retail settlement: customer USD finalizes from authenticated usage;
-- supplier reserves remain outstanding until separate verified reconciliation.
begin;
alter table apiwild_finance.gateway_requests add column if not exists supplier_pending boolean not null default false;
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
  select coalesce(sum(case when (state in ('reserved','executing','uncertain') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end),0),
    coalesce(sum(case when updated_at>=v_day or supplier_pending or state in ('reserved','executing','uncertain') then case when (state in ('reserved','executing','uncertain') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end else 0 end),0)
    into v_cny,v_cny_daily from apiwild_finance.gateway_requests where provider_budget_id=p_provider_budget_id;
  if v_cny+p_reserved_cny_micros>b.total_limit_cny_micros or v_cny_daily+p_reserved_cny_micros>b.daily_limit_cny_micros
  then raise exception 'gateway_provider_limit'; end if;
  insert into apiwild_finance.gateway_requests(id,user_id,key_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,reserved_cny_micros,expires_at)
    values(gen_random_uuid(),p_owner,p_key_id,p_provider_budget_id,p_request_key,p_payload_hash,p_capability,p_model,p_rate_version,'reserved',p_reserved_usd_micros,p_reserved_cny_micros,v_now+interval '2 minutes') returning * into r;
  return jsonb_build_object('fresh',true,'record',to_jsonb(r));
end;
$$;
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
  select coalesce(sum(case when (state in ('reserved','executing','uncertain') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end),0),
    coalesce(sum(case when updated_at>=v_day or supplier_pending or state in ('reserved','executing','uncertain') then case when (state in ('reserved','executing','uncertain') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end else 0 end),0)
    into v_cny,v_cny_daily from apiwild_finance.gateway_requests where provider_budget_id=r.provider_budget_id;
  if v_cny>b.total_limit_cny_micros or v_cny_daily>b.daily_limit_cny_micros then raise exception 'gateway_provider_limit'; end if;
  update apiwild_finance.gateway_requests set state='executing',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
  return jsonb_build_object('claimed',true,'record',to_jsonb(r));
end;
$$;
create or replace function public.apiwild_gateway_finish_retail(
 p_owner text,p_id uuid,p_expected_version bigint,p_state text,p_cost_usd_micros bigint,
 p_cost_cny_micros bigint,p_settlement_reference text,p_result jsonb,p_usage jsonb
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r apiwild_finance.gateway_requests; outcome jsonb;
begin
 if p_cost_cny_micros is distinct from 0 then raise exception 'supplier_cost_not_part_of_retail_settlement'; end if;
 r:=apiwild_finance.lock_request(p_owner,p_id);
 if r.state in ('succeeded','failed') and not r.supplier_pending then raise exception 'retail_settlement_already_reconciled'; end if;
 outcome:=public.apiwild_gateway_finish(p_owner,p_id,p_expected_version,p_state,p_cost_usd_micros,0,p_settlement_reference,p_result,p_usage);
 if (outcome->>'settled')::boolean then
  update apiwild_finance.gateway_requests set supplier_pending=true where id=p_id returning * into r;
  update apiwild_finance.gateway_outbox set payload=(payload-'cost_cny_micros')||jsonb_build_object('supplier_pending',true) where request_id=p_id;
  outcome:=jsonb_set(outcome,'{record}',to_jsonb(r));
 end if;
 return outcome;
end;$$;
create or replace function public.apiwild_gateway_reconcile_supplier(p_owner text,p_id uuid,p_cost_cny_micros bigint,p_reference text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r apiwild_finance.gateway_requests;
begin
 if p_cost_cny_micros is null or p_cost_cny_micros not between 0 and 1000000000000 or p_reference is null or length(p_reference) not between 1 and 500 then raise exception 'invalid_supplier_settlement';end if;
 r:=apiwild_finance.lock_request(p_owner,p_id);
 if not r.supplier_pending or r.state not in ('succeeded','failed') then raise exception 'supplier_reconciliation_not_pending';end if;
 if p_cost_cny_micros>r.reserved_cny_micros then
  update apiwild_finance.provider_budgets set accepted=false where id=r.provider_budget_id;
  update apiwild_finance.gateway_requests set observed_cny_micros=greatest(observed_cny_micros,p_cost_cny_micros) where id=p_id;
  return jsonb_build_object('reconciled',false,'reason','supplier_bound_exceeded');
 end if;
 update apiwild_finance.gateway_requests set cost_cny_micros=p_cost_cny_micros,observed_cny_micros=p_cost_cny_micros,supplier_pending=false,updated_at=clock_timestamp() where id=p_id;
 update apiwild_finance.gateway_outbox set payload=payload||jsonb_build_object('supplier_pending',false,'cost_cny_micros',p_cost_cny_micros,'supplier_settlement_reference',p_reference) where request_id=p_id;
 return jsonb_build_object('reconciled',true);
end;$$;
revoke all on function public.apiwild_gateway_finish_retail(text,uuid,bigint,text,bigint,bigint,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.apiwild_gateway_reconcile_supplier(text,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.apiwild_gateway_finish_retail(text,uuid,bigint,text,bigint,bigint,text,jsonb,jsonb) to service_role;
grant execute on function public.apiwild_gateway_reconcile_supplier(text,uuid,bigint,text) to service_role;
create or replace function public.apiwild_gateway_account_initialize(p_owner text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare customer uuid; mode text; a apiwild_finance.gateway_accounts;
begin
 if p_owner is null or p_owner !~ '^(live|test):supabase:[0-9a-f-]{36}$' then raise exception 'invalid_owner';end if;
 mode:=split_part(p_owner,':',1);customer:=split_part(p_owner,':',3)::uuid;
 if not exists(select 1 from auth.users u where u.id=customer and u.email_confirmed_at is not null and u.is_anonymous is false) then raise exception 'owner_not_onboarded';end if;
 insert into apiwild_finance.gateway_accounts(user_id,customer_id,billing_mode) values(p_owner,customer,mode) on conflict(user_id) do nothing;
 select * into a from apiwild_finance.gateway_accounts where user_id=p_owner;
 return jsonb_build_object('initialized',true,'customer_id',a.customer_id,'billing_mode',a.billing_mode);
end;$$;
create or replace function public.apiwild_gateway_usage(p_owner text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a apiwild_finance.gateway_accounts; spent bigint; held bigint; calls bigint;
begin
 perform apiwild_finance.assert_customer(p_owner);
 select * into a from apiwild_finance.gateway_accounts where user_id=p_owner;
 select coalesce(sum(cost_usd_micros) filter(where state='succeeded'),0),coalesce(sum(reserved_usd_micros) filter(where state in ('reserved','executing','uncertain')),0),count(*) filter(where state='succeeded') into spent,held,calls from apiwild_finance.gateway_requests where user_id=p_owner;
 return jsonb_build_object('currency','USD','fundedUsdMicros',a.funded_usd_micros,'spentUsdMicros',spent,'reservedUsdMicros',held,'paymentHoldUsdMicros',a.payment_hold_usd_micros,'availableUsdMicros',greatest(0,a.funded_usd_micros-spent-held-a.payment_hold_usd_micros),'completedRequests',calls);
end;$$;
revoke all on function public.apiwild_gateway_account_initialize(text) from public,anon,authenticated;
revoke all on function public.apiwild_gateway_usage(text) from public,anon,authenticated;
grant execute on function public.apiwild_gateway_account_initialize(text) to service_role;
grant execute on function public.apiwild_gateway_usage(text) to service_role;

create or replace function apiwild_finance.assert_customer(p_owner text)
returns void language plpgsql set search_path='' as $$ begin
 if p_owner is null or not exists(select 1 from apiwild_finance.gateway_accounts a join auth.users u on u.id=a.customer_id where a.user_id=p_owner and not a.suspended and u.email_confirmed_at is not null and u.is_anonymous is false) then raise exception 'gateway_customer_unavailable';end if;
end;$$;
commit;
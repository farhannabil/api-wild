-- Retain all uncertain customer/supplier financial holds. Only active requests occupy concurrency slots.
begin;
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
  if p_key_id is not null and (k.user_id<>p_owner or k.revoked_at is not null or (k.expires_at is not null and k.expires_at<=v_now)
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
    count(*) filter (where state in ('reserved','executing')),
    count(*) filter (where created_at>v_now-interval '1 minute')
    into v_usd,v_daily,v_held,v_minute from apiwild_finance.gateway_requests where user_id=p_owner;
  if v_usd+p_reserved_usd_micros>a.funded_usd_micros-a.payment_hold_usd_micros
    or v_daily+p_reserved_usd_micros>a.daily_limit_usd_micros
  then raise exception 'gateway_customer_limit'; end if;
  if v_held>=2 or v_minute>=20 then raise exception 'gateway_request_limit'; end if;
  if p_key_id is not null then
    select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
      coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0)
      into v_key_total,v_key_daily from apiwild_finance.gateway_requests where key_id=p_key_id;
    if (k.total_limit_usd_micros is not null and v_key_total+p_reserved_usd_micros>k.total_limit_usd_micros) or (k.daily_limit_usd_micros is not null and v_key_daily+p_reserved_usd_micros>k.daily_limit_usd_micros)
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

commit;

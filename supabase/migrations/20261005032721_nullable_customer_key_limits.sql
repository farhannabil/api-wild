-- Nullable key limits only; account and provider limits remain mandatory.
begin;
alter table apiwild_finance.gateway_keys alter column daily_limit_usd_micros drop not null, alter column total_limit_usd_micros drop not null, alter column expires_at drop not null;
create or replace function apiwild_finance.gateway_key_metadata(k apiwild_finance.gateway_keys)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',k.id,'customer_id',a.customer_id,'billing_mode',a.billing_mode,
 'scopes',k.scopes,'daily_limit_usd_micros',k.daily_limit_usd_micros,
 'total_limit_usd_micros',k.total_limit_usd_micros,'expires_at',k.expires_at,'revoked_at',k.revoked_at)
 from apiwild_finance.gateway_accounts a where a.user_id=k.user_id;
$$;
revoke all on function apiwild_finance.gateway_key_metadata(apiwild_finance.gateway_keys) from public,anon,authenticated,service_role;

create or replace function public.apiwild_gateway_key_issue(p_owner text,p_id uuid,p_hash text,p_scopes text[],p_daily_limit bigint,p_total_limit bigint,p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
declare k apiwild_finance.gateway_keys;
begin
 if p_id is null or p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_scopes is null
 or cardinality(p_scopes) not between 1 and 6 or array_position(p_scopes,null) is not null
 or not p_scopes<@array['chat','code','research','voice','transcribe','speak']::text[]
 or cardinality(p_scopes)<>(select count(distinct s) from unnest(p_scopes) s)
 or (p_daily_limit is not null and p_daily_limit not between 0 and 1000000000000)
 or (p_total_limit is not null and p_total_limit not between 0 and 1000000000000)
 or (p_daily_limit is not null and p_total_limit is not null and p_daily_limit>p_total_limit)
 or (p_expires_at is not null and (p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '365 days'))
 then raise exception 'gateway_key_invalid_input'; end if;
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 perform apiwild_finance.assert_customer(p_owner);
 if (select count(*) from apiwild_finance.gateway_keys where user_id=p_owner)>=100 then raise exception 'gateway_key_count_limit'; end if;
 insert into apiwild_finance.gateway_keys(id,user_id,hash,scopes,daily_limit_usd_micros,total_limit_usd_micros,expires_at)
 values(p_id,p_owner,p_hash,p_scopes,p_daily_limit,p_total_limit,p_expires_at) returning * into k;
 return apiwild_finance.gateway_key_metadata(k);
end;
$$;

create or replace function public.apiwild_gateway_key_list(p_owner text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
begin
 perform apiwild_finance.assert_customer(p_owner);
 return coalesce((select jsonb_agg(apiwild_finance.gateway_key_metadata(k) order by k.id) from apiwild_finance.gateway_keys k where k.user_id=p_owner),'[]'::jsonb);
end;
$$;

create or replace function public.apiwild_gateway_key_revoke(p_owner text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
declare k apiwild_finance.gateway_keys;
begin
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 perform apiwild_finance.assert_customer(p_owner);
 update apiwild_finance.gateway_keys set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=p_id and user_id=p_owner returning * into k;
 if not found then raise exception 'gateway_key_unavailable'; end if;
 return apiwild_finance.gateway_key_metadata(k);
end;
$$;

create or replace function public.apiwild_gateway_key_authenticate(p_hash text,p_mode text,p_capability text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare k apiwild_finance.gateway_keys;
begin
 if p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_mode is null or p_mode not in ('test','live')
 or p_capability is null or p_capability not in ('chat','code','research','voice','transcribe','speak') then raise exception 'gateway_key_unavailable'; end if;
 select x.* into k from apiwild_finance.gateway_keys x join apiwild_finance.gateway_accounts a on a.user_id=x.user_id
 where x.hash=p_hash and a.billing_mode=p_mode and x.revoked_at is null and (x.expires_at is null or x.expires_at>clock_timestamp()) and p_capability=any(x.scopes);
 if not found then raise exception 'gateway_key_unavailable'; end if;
 perform apiwild_finance.assert_customer(k.user_id);
 return apiwild_finance.gateway_key_metadata(k);
end;
$$;
revoke all on function public.apiwild_gateway_key_issue(text,uuid,text,text[],bigint,bigint,timestamptz),public.apiwild_gateway_key_list(text),public.apiwild_gateway_key_revoke(text,uuid),public.apiwild_gateway_key_authenticate(text,text,text) from public,anon,authenticated;
grant execute on function public.apiwild_gateway_key_issue(text,uuid,text,text[],bigint,bigint,timestamptz),public.apiwild_gateway_key_list(text),public.apiwild_gateway_key_revoke(text,uuid),public.apiwild_gateway_key_authenticate(text,text,text) to service_role;
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
    if k.user_id<>p_owner or k.revoked_at is not null or (k.expires_at is not null and k.expires_at<=clock_timestamp()) or not r.capability=any(k.scopes) then raise exception 'gateway_key_unavailable'; end if;
  end if;
  select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
    coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0)
    into v_used,v_daily from apiwild_finance.gateway_requests where user_id=p_owner;
  if v_used>a.funded_usd_micros-a.payment_hold_usd_micros or v_daily>a.daily_limit_usd_micros then raise exception 'gateway_customer_limit'; end if;
  if r.key_id is not null then
    select coalesce(sum(cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0),
      coalesce(sum(case when updated_at>=v_day or state in ('reserved','executing','uncertain') then cost_usd_micros+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end else 0 end),0)
      into v_key_total,v_key_daily from apiwild_finance.gateway_requests where key_id=r.key_id;
    if (k.total_limit_usd_micros is not null and v_key_total>k.total_limit_usd_micros) or (k.daily_limit_usd_micros is not null and v_key_daily>k.daily_limit_usd_micros) then raise exception 'gateway_key_limit'; end if;
  end if;
  select coalesce(sum(case when (state in ('reserved','executing','uncertain') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end),0),
    coalesce(sum(case when updated_at>=v_day or supplier_pending or state in ('reserved','executing','uncertain') then case when (state in ('reserved','executing','uncertain') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end else 0 end),0)
    into v_cny,v_cny_daily from apiwild_finance.gateway_requests where provider_budget_id=r.provider_budget_id;
  if v_cny>b.total_limit_cny_micros or v_cny_daily>b.daily_limit_cny_micros then raise exception 'gateway_provider_limit'; end if;
  update apiwild_finance.gateway_requests set state='executing',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
  return jsonb_build_object('claimed',true,'record',to_jsonb(r));
end;
$$;

commit;

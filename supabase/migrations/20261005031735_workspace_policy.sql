begin;
create table if not exists apiwild_finance.workspace_policies(user_id text primary key references apiwild_finance.gateway_accounts(user_id),capabilities text[] not null,updated_at timestamptz not null default clock_timestamp());
alter table apiwild_finance.workspace_policies enable row level security;
revoke all on apiwild_finance.workspace_policies from public,anon,authenticated,service_role;
create or replace function apiwild_finance.workspace_policy(p_owner text,p_capabilities text[],p_daily_limit bigint)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
declare a apiwild_finance.gateway_accounts; allowed text[];
begin
 select * into a from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 if not found then raise exception 'workspace_unavailable';end if;
 perform apiwild_finance.assert_customer(p_owner);
 if p_capabilities is not null or p_daily_limit is not null then
  if p_capabilities is null or p_daily_limit is null or p_daily_limit not between 0 and 1000000000000
   or cardinality(p_capabilities)>6 or array_position(p_capabilities,null) is not null
   or not p_capabilities<@array['chat','code','research','voice','transcribe','speak']::text[]
   or cardinality(p_capabilities)<>(select count(distinct c) from unnest(p_capabilities)c) then raise exception 'invalid_policy';end if;
  insert into apiwild_finance.workspace_policies(user_id,capabilities) values(p_owner,p_capabilities) on conflict(user_id) do update set capabilities=excluded.capabilities,updated_at=clock_timestamp();
  update apiwild_finance.gateway_accounts set daily_limit_usd_micros=p_daily_limit where user_id=p_owner;
  a.daily_limit_usd_micros:=p_daily_limit;
 end if;
 select capabilities into allowed from apiwild_finance.workspace_policies where user_id=p_owner;
 return jsonb_build_object('workspaceType','personal','members',jsonb_build_array(jsonb_build_object('customerId',a.customer_id,'role','owner')),'roles',jsonb_build_array(jsonb_build_object('name','owner','permissions',jsonb_build_array('manage_keys','manage_billing','manage_guardrails','view_usage'))),'capabilities',coalesce(allowed,array['chat','code','research','voice','transcribe','speak']::text[]),'dailyLimitUsdMicros',a.daily_limit_usd_micros,'sharedMembershipEnabled',false);
end;$$;
create or replace function public.apiwild_workspace_policy(p_owner text,p_capabilities text[] default null,p_daily_limit bigint default null)
returns jsonb language sql security invoker set search_path='' set statement_timeout='10s' as $$ select apiwild_finance.workspace_policy(p_owner,p_capabilities,p_daily_limit);$$;
revoke all on function apiwild_finance.workspace_policy(text,text[],bigint),public.apiwild_workspace_policy(text,text[],bigint) from public,anon,authenticated;
grant execute on function apiwild_finance.workspace_policy(text,text[],bigint),public.apiwild_workspace_policy(text,text[],bigint) to service_role;
create or replace function apiwild_finance.enforce_workspace_policy()
returns trigger language plpgsql security definer set search_path='' as $$
declare allowed text[]; daily bigint; used bigint;
begin
 select daily_limit_usd_micros into daily from apiwild_finance.gateway_accounts where user_id=new.user_id for update;
 select capabilities into allowed from apiwild_finance.workspace_policies where user_id=new.user_id;
 if allowed is not null and not(new.capability=any(allowed)) then raise exception 'workspace_capability_denied';end if;
 if TG_OP='UPDATE' then return new;end if;
 select coalesce(sum(coalesce(cost_usd_micros,0)+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0) into used from apiwild_finance.gateway_requests where user_id=new.user_id and (updated_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' or state in ('reserved','executing','uncertain'));
 if new.reserved_usd_micros+used>daily then raise exception 'workspace_daily_limit';end if;
 return new;
end;$$;
revoke all on function apiwild_finance.enforce_workspace_policy() from public,anon,authenticated,service_role;
drop trigger if exists enforce_workspace_policy on apiwild_finance.gateway_requests;
create trigger enforce_workspace_policy before insert on apiwild_finance.gateway_requests for each row execute function apiwild_finance.enforce_workspace_policy();
drop trigger if exists enforce_workspace_policy_claim on apiwild_finance.gateway_requests;
create trigger enforce_workspace_policy_claim before update of state on apiwild_finance.gateway_requests for each row when (new.state='executing' and old.state is distinct from new.state) execute function apiwild_finance.enforce_workspace_policy();
commit;

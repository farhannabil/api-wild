begin;
create table apiwild_finance.native_customer_keys (
 key_id uuid primary key references apiwild_finance.gateway_keys(id),
 provider_budget_id uuid not null references apiwild_finance.provider_budgets(id),
 account_id bigint not null check(account_id>0), token_id bigint unique,
 token_name text not null unique, rates jsonb not null,
 created_at timestamptz not null default clock_timestamp(), last_synced_at timestamptz,
 lease_id uuid references apiwild_finance.gateway_requests(id),
 sync_owner uuid, sync_until timestamptz,
 check(jsonb_typeof(rates)='object' and octet_length(rates::text)<65536)
);
create table apiwild_finance.native_usage_receipts (
 account_id bigint not null, log_id bigint not null,
 key_id uuid not null references apiwild_finance.native_customer_keys(key_id),
 request_id uuid not null unique references apiwild_finance.gateway_requests(id),
 fact jsonb not null, quota bigint not null check(quota>=0),
 primary key(account_id,log_id)
);
alter table apiwild_finance.native_customer_keys enable row level security;
alter table apiwild_finance.native_usage_receipts enable row level security;
revoke all on apiwild_finance.native_customer_keys,apiwild_finance.native_usage_receipts from public,anon,authenticated,service_role;

create function public.apiwild_native_key_prepare(p_owner text,p_id uuid,p_hash text,p_daily bigint,p_total bigint,p_expires timestamptz,p_budget uuid,p_account bigint,p_rates jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare v jsonb; b apiwild_finance.provider_budgets; r record;
begin
 select * into b from apiwild_finance.provider_budgets where id=p_budget for update;
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 perform apiwild_finance.assert_customer(p_owner);
 if b.id is null or not b.accepted or b.billing_mode<>'live' or p_owner not like 'live:supabase:%' or p_account is null or p_account<1 or jsonb_typeof(p_rates) is distinct from 'object' then raise exception 'native_invalid_configuration'; end if;
 if exists(select 1 from apiwild_finance.native_customer_keys n join apiwild_finance.gateway_keys k on k.id=n.key_id where k.user_id=p_owner and k.revoked_at is null) then raise exception 'native_existing_key'; end if;
 if (select count(*) from jsonb_each(p_rates)) not between 1 and 32 then raise exception 'native_invalid_rates'; end if;
 for r in select * from jsonb_each(p_rates) loop
  if r.value->>'input' is null or r.value->>'output' is null or not r.key=any(b.models) or (r.value->>'input')::bigint not between 0 and 10000000000 or (r.value->>'output')::bigint not between 0 and 10000000000 or coalesce(length(r.value->>'provider'),0)=0 then raise exception 'native_invalid_rates'; end if;
 end loop;
 v:=public.apiwild_gateway_key_issue(p_owner,p_id,p_hash,array['chat','code','research'],p_daily,p_total,p_expires);
 insert into apiwild_finance.native_customer_keys(key_id,provider_budget_id,account_id,token_name,rates) values(p_id,p_budget,p_account,'apiwild-customer-'||p_id,p_rates);
 return v;
end; $$;
create function public.apiwild_native_key_attach(p_owner text,p_id uuid,p_token bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_token is null or p_token<1 then raise exception 'native_invalid_token'; end if;
 update apiwild_finance.native_customer_keys n set token_id=p_token from apiwild_finance.gateway_keys k where n.key_id=k.id and k.id=p_id and k.user_id=p_owner and (n.token_id is null or n.token_id=p_token);
 if not found then raise exception 'native_key_unavailable'; end if; return true;
end; $$;
create function public.apiwild_native_key_rows(p_owner text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_owner is not null then perform apiwild_finance.assert_customer(p_owner); end if;
 return coalesce((select jsonb_agg(to_jsonb(n)||jsonb_build_object('owner',k.user_id,'revoked_at',k.revoked_at,'expires_at',k.expires_at,'daily_limit',k.daily_limit_usd_micros,'total_limit',k.total_limit_usd_micros)) from apiwild_finance.native_customer_keys n join apiwild_finance.gateway_keys k on k.id=n.key_id where p_owner is null or k.user_id=p_owner),'[]'::jsonb);
end; $$;
create function public.apiwild_native_sync_claim(p_key uuid,p_run uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_run is null then raise exception 'native_sync_invalid'; end if;
 update apiwild_finance.native_customer_keys set sync_owner=p_run,sync_until=clock_timestamp()+interval '10 minutes' where key_id=p_key and (sync_until is null or sync_until<clock_timestamp());return found;
end; $$;
create function public.apiwild_native_import(p_key uuid,p_run uuid,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare n apiwild_finance.native_customer_keys; k apiwild_finance.gateway_keys; b apiwild_finance.provider_budgets; f jsonb; old apiwild_finance.native_usage_receipts; rate jsonb; usd bigint; cny bigint; req uuid; imports int:=0;
begin
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key;
 select * into b from apiwild_finance.provider_budgets where id=n.provider_budget_id for update;
 select * into k from apiwild_finance.gateway_keys where id=p_key;
 perform 1 from apiwild_finance.gateway_accounts where user_id=k.user_id for update;
 perform 1 from apiwild_finance.gateway_keys where id=p_key for update;
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key for update;
 if p_run is null or n.key_id is null or n.sync_owner is distinct from p_run or n.sync_until is null or n.sync_until<clock_timestamp() or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 then raise exception 'native_sync_unavailable'; end if;
 for f in select value from jsonb_array_elements(p_rows) loop
  if not (f ?& array['id','token','account','prompt','completion','quota','created','model','provider']) or exists(select 1 from jsonb_each(f) e where e.value='null'::jsonb) or (f->>'id')::bigint<1 or (f->>'token')::bigint is distinct from n.token_id or (f->>'account')::bigint is distinct from n.account_id or (f->>'prompt')::bigint not between 0 and 10000000 or (f->>'completion')::bigint not between 0 and 10000000 or (f->>'quota')::bigint not between 0 and 3676470 or (f->>'created')::bigint<extract(epoch from n.created_at)::bigint-5 then raise exception 'native_receipt_invalid'; end if;
  rate:=n.rates->(f->>'model');
  if rate is null or rate->>'provider' is distinct from f->>'provider' then raise exception 'native_receipt_route_invalid'; end if;
  select * into old from apiwild_finance.native_usage_receipts where account_id=n.account_id and log_id=(f->>'id')::bigint;
  if found then if old.key_id<>p_key or old.fact<>f then raise exception 'native_receipt_conflict'; end if;continue;end if;
  usd:=ceil(((f->>'prompt')::numeric*(rate->>'input')::numeric+(f->>'completion')::numeric*(rate->>'output')::numeric)/1000000);
  cny:=ceil((f->>'quota')::numeric*68/5);
  if usd not between 0 and 1000000000000 or cny not between 0 and 50000000 then raise exception 'native_receipt_cost_invalid'; end if;
  if n.lease_id is not null then update apiwild_finance.gateway_requests set reserved_usd_micros=greatest(1,reserved_usd_micros-usd),reserved_cny_micros=greatest(1,reserved_cny_micros-cny) where id=n.lease_id and state='uncertain';end if;
  req:=gen_random_uuid();
  insert into apiwild_finance.gateway_requests(id,user_id,key_id,provider_budget_id,request_key,payload_hash,capability,model,rate_version,state,reserved_usd_micros,cost_usd_micros,reserved_cny_micros,cost_cny_micros,settlement_reference,usage_json,created_at,expires_at)
  values(req,k.user_id,p_key,b.id,'native_receipt_'||n.account_id||'_'||(f->>'id'),repeat('0',64),'chat',f->>'model',b.rate_version,'succeeded',greatest(1,usd),usd,greatest(1,cny),cny,'native-log:'||n.account_id||':'||(f->>'id'),jsonb_build_object('prompt_tokens',(f->>'prompt')::bigint,'completion_tokens',(f->>'completion')::bigint,'nativeHourlyImport',true,'nativeLogId',(f->>'id')::bigint),to_timestamp((f->>'created')::bigint),clock_timestamp());
  insert into apiwild_finance.native_usage_receipts values(n.account_id,(f->>'id')::bigint,p_key,req,f,(f->>'quota')::bigint);imports:=imports+1;
 end loop;
 return jsonb_build_object('imported',imports,'quota',(select coalesce(sum(quota),0) from apiwild_finance.native_usage_receipts where key_id=p_key));
end; $$;
create function public.apiwild_native_sync_finish(p_key uuid,p_run uuid,p_used bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare n apiwild_finance.native_customer_keys; k apiwild_finance.gateway_keys;
begin
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key;
 perform 1 from apiwild_finance.provider_budgets where id=n.provider_budget_id for update;
 select * into k from apiwild_finance.gateway_keys where id=p_key;
 perform 1 from apiwild_finance.gateway_accounts where user_id=k.user_id for update;
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key for update;
 if p_run is null or n.key_id is null or n.sync_owner is distinct from p_run or n.sync_until is null or n.sync_until<clock_timestamp() or p_used is null or p_used<>(select coalesce(sum(quota),0) from apiwild_finance.native_usage_receipts where key_id=p_key) then raise exception 'native_receipts_incomplete'; end if;
 if n.lease_id is not null then update apiwild_finance.gateway_requests set state='cancelled',updated_at=clock_timestamp() where id=n.lease_id and state='uncertain';end if;
 update apiwild_finance.native_customer_keys set lease_id=null,last_synced_at=clock_timestamp() where key_id=p_key;return true;
end; $$;
create function public.apiwild_native_allocate(p_key uuid,p_run uuid,p_usd bigint,p_cny bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n apiwild_finance.native_customer_keys; k apiwild_finance.gateway_keys; b apiwild_finance.provider_budgets; v jsonb; rid uuid; m text;
begin
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key;
 select * into b from apiwild_finance.provider_budgets where id=n.provider_budget_id for update;
 select * into k from apiwild_finance.gateway_keys where id=p_key;
 perform 1 from apiwild_finance.gateway_accounts where user_id=k.user_id for update;
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key for update;
 if p_run is null or n.key_id is null or n.sync_owner is distinct from p_run or n.sync_until is null or n.sync_until<clock_timestamp() or n.lease_id is not null or n.last_synced_at is null or n.last_synced_at<clock_timestamp()-interval '5 minutes' or k.revoked_at is not null or (k.expires_at is not null and k.expires_at<=clock_timestamp()) or p_usd is null or p_cny is null or p_usd not between 1 and 1000000 or p_cny not between 1 and 68000 then raise exception 'native_allocation_unavailable'; end if;
 select key into m from jsonb_each(n.rates) limit 1;
 v:=public.apiwild_gateway_reserve(k.user_id,p_key,b.id,'native_lease_'||replace(p_run::text,'-',''),repeat('0',64),'chat',m,b.rate_version,p_usd,p_cny);
 rid:=(v->'record'->>'id')::uuid;
 update apiwild_finance.gateway_requests set state='uncertain',usage_json=jsonb_build_object('nativeAllowance',true),expires_at=clock_timestamp()+interval '65 minutes' where id=rid;
 update apiwild_finance.native_customer_keys set lease_id=rid where key_id=p_key;
 return jsonb_build_object('requestId',rid,'reservedUsdMicros',p_usd,'reservedCnyMicros',p_cny);
end; $$;
-- All calls are internal, made after server verification of the signed-in owner.
revoke all on function public.apiwild_native_key_prepare(text,uuid,text,bigint,bigint,timestamptz,uuid,bigint,jsonb),public.apiwild_native_key_attach(text,uuid,bigint),public.apiwild_native_key_rows(text),public.apiwild_native_sync_claim(uuid,uuid),public.apiwild_native_import(uuid,uuid,jsonb),public.apiwild_native_sync_finish(uuid,uuid,bigint),public.apiwild_native_allocate(uuid,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.apiwild_native_key_prepare(text,uuid,text,bigint,bigint,timestamptz,uuid,bigint,jsonb),public.apiwild_native_key_attach(text,uuid,bigint),public.apiwild_native_key_rows(text),public.apiwild_native_sync_claim(uuid,uuid),public.apiwild_native_import(uuid,uuid,jsonb),public.apiwild_native_sync_finish(uuid,uuid,bigint),public.apiwild_native_allocate(uuid,uuid,bigint,bigint) to service_role;


create function public.apiwild_native_sync_assert(p_key uuid,p_run uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_run is null or not exists(select 1 from apiwild_finance.native_customer_keys n join apiwild_finance.gateway_keys k on k.id=n.key_id where n.key_id=p_key and n.sync_owner=p_run and n.sync_until>clock_timestamp()+interval '2 minutes' and k.revoked_at is null and (k.expires_at is null or k.expires_at>clock_timestamp())) then raise exception 'native_sync_unavailable'; end if;
 return true;
end;$$;
revoke all on function public.apiwild_native_sync_assert(uuid,uuid) from public,anon,authenticated;
grant execute on function public.apiwild_native_sync_assert(uuid,uuid) to service_role;
create function public.apiwild_native_sync_release(p_key uuid,p_run uuid) returns boolean language plpgsql security definer set search_path='' as $$ begin update apiwild_finance.native_customer_keys set sync_owner=null,sync_until=null where key_id=p_key and sync_owner=p_run;return found;end;$$;
revoke all on function public.apiwild_native_sync_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.apiwild_native_sync_release(uuid,uuid) to service_role;
create or replace function apiwild_finance.enforce_workspace_policy()
returns trigger language plpgsql security definer set search_path='' as $$
declare allowed text[]; daily bigint; used bigint;
begin
 -- Existing usage is a settlement fact, never a new admission request.
 if TG_OP='INSERT' and new.state='succeeded' and new.usage_json->>'nativeHourlyImport'='true' and exists(select 1 from apiwild_finance.native_customer_keys where key_id=new.key_id) then return new;end if;
 select daily_limit_usd_micros into daily from apiwild_finance.gateway_accounts where user_id=new.user_id for update;
 select capabilities into allowed from apiwild_finance.workspace_policies where user_id=new.user_id;
 if allowed is not null and not(new.capability=any(allowed)) then raise exception 'workspace_capability_denied';end if;
 if TG_OP='UPDATE' then return new;end if;
 select coalesce(sum(coalesce(cost_usd_micros,0)+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0) into used from apiwild_finance.gateway_requests where user_id=new.user_id and (updated_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' or state in ('reserved','executing','uncertain'));
 if new.reserved_usd_micros+used>daily then raise exception 'workspace_daily_limit';end if;
 return new;
end;$$;
revoke all on function apiwild_finance.enforce_workspace_policy() from public,anon,authenticated,service_role;

commit;

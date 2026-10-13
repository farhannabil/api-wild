begin;
create table apiwild_finance.usage_token_details(
 request_id uuid primary key references apiwild_finance.gateway_requests(id),
 cache_read_tokens bigint check(cache_read_tokens between 0 and 1000000000),
 cache_write_tokens bigint check(cache_write_tokens between 0 and 1000000000),
 updated_at timestamptz not null default clock_timestamp()
);
create table apiwild_finance.usage_daily(
 owner text not null, day date not null, model text not null,
 requests bigint not null, input_tokens bigint not null, output_tokens bigint not null,
 cache_read_tokens bigint not null, cache_write_tokens bigint not null,
 cache_read_known bigint not null, cache_write_known bigint not null,
 charged_usd_micros bigint not null, pending_requests bigint not null,
 primary key(owner,day,model)
);
create table apiwild_finance.usage_job_status(name text primary key,last_success_at timestamptz not null,result jsonb not null);
create table apiwild_finance.billing_audit_status(owner text primary key,checked_at timestamptz not null,mismatches bigint not null,overdue_requests bigint not null,stale_keys bigint not null);
alter table apiwild_finance.usage_token_details enable row level security;
alter table apiwild_finance.usage_daily enable row level security;
alter table apiwild_finance.usage_job_status enable row level security;
alter table apiwild_finance.billing_audit_status enable row level security;
revoke all on apiwild_finance.usage_token_details,apiwild_finance.usage_daily,apiwild_finance.usage_job_status,apiwild_finance.billing_audit_status from public,anon,authenticated,service_role;

-- Supplement immutable billing facts without changing their dedup identity.
create function public.apiwild_native_usage_details(p_key uuid,p_run uuid,p_rows jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare n apiwild_finance.native_customer_keys; f jsonb; receipt apiwild_finance.native_usage_receipts; old apiwild_finance.usage_token_details; cr bigint; cw bigint; count_rows int:=0;
begin
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key for update;
 if n.key_id is null or p_run is null or n.sync_owner is distinct from p_run or n.sync_until is null or n.sync_until<clock_timestamp() or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 then raise exception 'analytics_lease_invalid';end if;
 for f in select value from jsonb_array_elements(p_rows) loop
  select * into receipt from apiwild_finance.native_usage_receipts where account_id=n.account_id and log_id=(f->'fact'->>'id')::bigint;
  if receipt.key_id is distinct from p_key or receipt.fact is distinct from f->'fact' then raise exception 'analytics_receipt_invalid';end if;
  cr:=(f->>'cacheReadTokens')::bigint;cw:=(f->>'cacheWriteTokens')::bigint;
  select * into old from apiwild_finance.usage_token_details where request_id=receipt.request_id;
  if (old.cache_read_tokens is not null and cr is not null and old.cache_read_tokens<>cr) or (old.cache_write_tokens is not null and cw is not null and old.cache_write_tokens<>cw) then raise exception 'analytics_detail_conflict';end if;
  insert into apiwild_finance.usage_token_details values(receipt.request_id,cr,cw,clock_timestamp()) on conflict(request_id) do update set cache_read_tokens=coalesce(apiwild_finance.usage_token_details.cache_read_tokens,excluded.cache_read_tokens),cache_write_tokens=coalesce(apiwild_finance.usage_token_details.cache_write_tokens,excluded.cache_write_tokens),updated_at=excluded.updated_at;
  count_rows:=count_rows+1;
 end loop;
 return jsonb_build_object('processed',count_rows);
end;$$;

create function apiwild_finance.usage_integer(v jsonb) returns bigint language sql immutable set search_path='' as $$
 select case when jsonb_typeof(v)='number' and v::text~'^[0-9]{1,12}$' then (v::text)::bigint else null end;
$$;

create function apiwild_finance.refresh_usage_dashboard() returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare affected bigint; result jsonb;
begin
 if not pg_try_advisory_xact_lock(20261013,201) then return '{"busy":true}'::jsonb;end if;
 -- Rebuild derived buckets atomically; late settlement and cancellation replace
 -- previous projections. Canonical financial records are never changed.
 delete from apiwild_finance.usage_daily;
 insert into apiwild_finance.usage_daily
 select r.user_id,(r.created_at at time zone 'UTC')::date,r.model,count(*),
  coalesce(sum(apiwild_finance.usage_integer(r.usage_json->'prompt_tokens')),0),
  coalesce(sum(apiwild_finance.usage_integer(r.usage_json->'completion_tokens')),0),
  coalesce(sum(coalesce(d.cache_read_tokens,apiwild_finance.usage_integer(r.usage_json->'cache_read_tokens'))),0),coalesce(sum(coalesce(d.cache_write_tokens,apiwild_finance.usage_integer(r.usage_json->'cache_write_tokens'))),0),count(coalesce(d.cache_read_tokens,apiwild_finance.usage_integer(r.usage_json->'cache_read_tokens'))),count(coalesce(d.cache_write_tokens,apiwild_finance.usage_integer(r.usage_json->'cache_write_tokens'))),
  sum(r.cost_usd_micros),count(*) filter(where r.usage_json->>'customerChargePending'='true' or r.state='uncertain')
 from apiwild_finance.gateway_requests r left join apiwild_finance.usage_token_details d on d.request_id=r.id
 where r.state in('succeeded','failed','uncertain') and coalesce(r.usage_json->>'nativeAllowance','false')<>'true'
 group by r.user_id,(r.created_at at time zone 'UTC')::date,r.model
 on conflict(owner,day,model) do update set requests=excluded.requests,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens,cache_read_known=excluded.cache_read_known,cache_write_known=excluded.cache_write_known,charged_usd_micros=excluded.charged_usd_micros,pending_requests=excluded.pending_requests;
 get diagnostics affected=row_count;result:=jsonb_build_object('buckets',affected);
 insert into apiwild_finance.usage_job_status values('usage-dashboard-hourly',clock_timestamp(),result) on conflict(name) do update set last_success_at=excluded.last_success_at,result=excluded.result;
 return result;
end;$$;

create function apiwild_finance.audit_customer_billing() returns jsonb language plpgsql security definer set search_path='' set statement_timeout='30s' as $$
declare result jsonb;
begin
 if not pg_try_advisory_xact_lock(20261013,202) then return '{"busy":true}'::jsonb;end if;
 insert into apiwild_finance.billing_audit_status
 select a.user_id,clock_timestamp(),
 (select count(*) from apiwild_finance.gateway_requests r where r.user_id=a.user_id and r.usage_json->>'billingPolicy'='supplier-cost-5x-v1' and r.state in('succeeded','failed') and coalesce(r.usage_json->>'customerChargePending','false')<>'true' and (apiwild_finance.usage_integer(r.usage_json->'supplierUsdMicros') is null or r.cost_usd_micros<>apiwild_finance.usage_integer(r.usage_json->'supplierUsdMicros')*5 or apiwild_finance.usage_integer(r.usage_json->'extraFeeUsdMicros') is distinct from 0::bigint)),
 (select count(*) from apiwild_finance.gateway_requests r where r.user_id=a.user_id and r.usage_json->>'customerChargePending'='true' and r.updated_at<clock_timestamp()-interval '2 hours'),
 (select count(*) from apiwild_finance.native_customer_keys n join apiwild_finance.gateway_keys k on k.id=n.key_id where k.user_id=a.user_id and k.revoked_at is null and k.expires_at>clock_timestamp() and n.created_at<clock_timestamp()-interval '75 minutes' and (n.last_synced_at is null or n.last_synced_at<clock_timestamp()-interval '75 minutes'))
 from apiwild_finance.gateway_accounts a
 on conflict(owner) do update set checked_at=excluded.checked_at,mismatches=excluded.mismatches,overdue_requests=excluded.overdue_requests,stale_keys=excluded.stale_keys;
 select jsonb_build_object('mismatches',coalesce(sum(mismatches),0),'overdueRequests',coalesce(sum(overdue_requests),0),'staleKeys',coalesce(sum(stale_keys),0)) into result from apiwild_finance.billing_audit_status;
 insert into apiwild_finance.usage_job_status values('billing-audit-hourly',clock_timestamp(),result) on conflict(name) do update set last_success_at=excluded.last_success_at,result=excluded.result;
 return result;
end;$$;

create function public.apiwild_usage_dashboard(p_owner text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare days jsonb; models jsonb; totals jsonb; audit jsonb;
begin
 perform apiwild_finance.assert_customer(p_owner);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.day),'[]'::jsonb) into days from (
 select day,sum(requests) requests,sum(input_tokens) "inputTokens",sum(output_tokens) "outputTokens",sum(cache_read_tokens) "cacheReadTokens",sum(cache_write_tokens) "cacheWriteTokens",sum(cache_read_known) "cacheReadKnown",sum(cache_write_known) "cacheWriteKnown",sum(charged_usd_micros) "chargedUsdMicros",sum(pending_requests) "pendingRequests" from apiwild_finance.usage_daily where owner=p_owner and day>=(clock_timestamp() at time zone 'UTC')::date-29 group by day) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into models from (select model,sum(requests) requests,sum(charged_usd_micros) "chargedUsdMicros" from apiwild_finance.usage_daily where owner=p_owner and day>=(clock_timestamp() at time zone 'UTC')::date-29 group by model order by sum(charged_usd_micros) desc,model limit 100) x;
 select jsonb_build_object('requests',coalesce(sum(requests),0),'inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0),'cacheReadTokens',coalesce(sum(cache_read_tokens),0),'cacheWriteTokens',coalesce(sum(cache_write_tokens),0),'cacheReadKnown',coalesce(sum(cache_read_known),0),'cacheWriteKnown',coalesce(sum(cache_write_known),0),'chargedUsdMicros',coalesce(sum(charged_usd_micros),0),'pendingRequests',coalesce(sum(pending_requests),0)) into totals from apiwild_finance.usage_daily where owner=p_owner and day>=(clock_timestamp() at time zone 'UTC')::date-29;
 select jsonb_build_object('checkedAt',checked_at,'mismatches',mismatches,'overdueRequests',overdue_requests,'staleKeys',stale_keys) into audit from apiwild_finance.billing_audit_status where owner=p_owner;
 return jsonb_build_object('currency','USD','windowDays',30,'timezone','UTC','days',days,'models',models,'totals',totals,'refreshedAt',(select last_success_at from apiwild_finance.usage_job_status where name='usage-dashboard-hourly'),'billingCheck',audit);
end;$$;
revoke all on function public.apiwild_native_usage_details(uuid,uuid,jsonb),public.apiwild_usage_dashboard(text),apiwild_finance.usage_integer(jsonb),apiwild_finance.refresh_usage_dashboard(),apiwild_finance.audit_customer_billing() from public,anon,authenticated,service_role;
grant execute on function public.apiwild_native_usage_details(uuid,uuid,jsonb),public.apiwild_usage_dashboard(text) to service_role;
commit;

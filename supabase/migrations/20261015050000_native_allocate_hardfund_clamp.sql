-- The 5x hardfund worker funds a native token from the customer's full
-- available balance, but apiwild_native_allocate still rejected any reserve
-- above $1.00, so every funded native key failed allocation and stayed
-- stopped (401). The function now accepts the full range and clamps the
-- reserve to the real remaining headroom -- wallet, account daily limit, key
-- daily/total limits, supplier budget, and the gateway reserve parameter
-- ceiling -- returning the amounts actually reserved so the worker funds the
-- token with exactly the backed quota.

create or replace function public.apiwild_native_allocate(p_key uuid,p_run uuid,p_usd bigint,p_cny bigint)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare n apiwild_finance.native_customer_keys; k apiwild_finance.gateway_keys; b apiwild_finance.provider_budgets; a apiwild_finance.gateway_accounts;
 v jsonb; rid uuid; m text; v_now timestamptz; v_day timestamptz;
 v_out numeric; v_today numeric; v_key_all numeric; v_key_today numeric; v_bud_all numeric; v_bud_today numeric;
 v_usd numeric; v_cny numeric; v_q bigint;
begin
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key;
 select * into b from apiwild_finance.provider_budgets where id=n.provider_budget_id for update;
 select * into k from apiwild_finance.gateway_keys where id=p_key;
 select * into a from apiwild_finance.gateway_accounts where user_id=k.user_id for update;
 select * into n from apiwild_finance.native_customer_keys where key_id=p_key for update;
 if p_run is null or n.key_id is null or a.user_id is null or n.sync_owner is distinct from p_run or n.sync_until is null or n.sync_until<clock_timestamp() or n.lease_id is not null or n.last_synced_at is null or n.last_synced_at<clock_timestamp()-interval '5 minutes' or k.revoked_at is not null or (k.expires_at is not null and k.expires_at<=clock_timestamp()) or p_usd is null or p_cny is null or p_usd not between 1 and 1000000000000 or p_cny not between 1 and 1360000000000 then raise exception 'native_allocation_unavailable'; end if;
 v_now:=clock_timestamp(); v_day:=(date_trunc('day',v_now at time zone 'UTC') at time zone 'UTC');
 -- Customer-usd headroom, matching the checks inside apiwild_gateway_reserve.
 select coalesce(sum(cost_usd_micros+case when (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then reserved_usd_micros else 0 end),0),
  coalesce(sum(case when updated_at>=v_day or (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then cost_usd_micros+case when (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then reserved_usd_micros else 0 end else 0 end),0)
  into v_out,v_today from apiwild_finance.gateway_requests where user_id=k.user_id;
 v_usd:=least(p_usd,a.funded_usd_micros-a.payment_hold_usd_micros-v_out,a.daily_limit_usd_micros-v_today);
 if k.total_limit_usd_micros is not null or k.daily_limit_usd_micros is not null then
  select coalesce(sum(cost_usd_micros+case when (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then reserved_usd_micros else 0 end),0),
   coalesce(sum(case when updated_at>=v_day or (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then cost_usd_micros+case when (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then reserved_usd_micros else 0 end else 0 end),0)
   into v_key_all,v_key_today from apiwild_finance.gateway_requests where key_id=p_key;
  if k.total_limit_usd_micros is not null then v_usd:=least(v_usd,k.total_limit_usd_micros-v_key_all); end if;
  if k.daily_limit_usd_micros is not null then v_usd:=least(v_usd,k.daily_limit_usd_micros-v_key_today); end if;
 end if;
 -- Supplier-cny headroom, plus the reserve function's own parameter ceiling.
 select coalesce(sum(case when ((state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end),0),
  coalesce(sum(case when updated_at>=v_day or supplier_pending or (state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') then case when ((state in ('reserved','executing','uncertain') or usage_json->>'customerChargePending'='true') or supplier_pending) then greatest(reserved_cny_micros,observed_cny_micros) else cost_cny_micros end else 0 end),0)
  into v_bud_all,v_bud_today from apiwild_finance.gateway_requests where provider_budget_id=n.provider_budget_id;
 v_cny:=least(p_cny,50000000,b.total_limit_cny_micros-v_bud_all,b.daily_limit_cny_micros-v_bud_today);
 -- One quota unit is 10 customer usd micros and 68/5 supplier cny micros; the grant must satisfy both sides.
 v_q:=floor(least(v_usd/10,v_cny*5.0/68))::bigint;
 if v_q is null or v_q<1 then raise exception 'native_allocation_unavailable'; end if;
 select key into m from jsonb_each(n.rates) limit 1;
 v:=public.apiwild_gateway_reserve(k.user_id,p_key,b.id,'native_lease_'||replace(p_run::text,'-',''),repeat('0',64),'chat',m,case when m='deepseek-v4.1-flash' then b.rate_version||':ds26:peak' else b.rate_version end,v_q*10,ceil(v_q*68.0/5)::bigint);
 rid:=(v->'record'->>'id')::uuid;
 update apiwild_finance.gateway_requests set state='uncertain',usage_json=jsonb_build_object('nativeAllowance',true),expires_at=v_now+interval '65 minutes' where id=rid;
 update apiwild_finance.native_customer_keys set lease_id=rid where key_id=p_key;
 return jsonb_build_object('requestId',rid,'reservedUsdMicros',v_q*10,'reservedCnyMicros',ceil(v_q*68.0/5)::bigint);
end; $$;

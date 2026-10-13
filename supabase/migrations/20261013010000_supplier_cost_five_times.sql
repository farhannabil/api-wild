begin;
-- Activation is a separate, one-time operator step after the compatible app deploys.
create table apiwild_finance.customer_billing_policy (
 id text primary key check(id='supplier-cost-5x-v1'),
 effective_at timestamptz,
 multiplier integer not null default 5 check(multiplier=5),
 extra_fee_usd_micros bigint not null default 0 check(extra_fee_usd_micros=0)
);
insert into apiwild_finance.customer_billing_policy(id) values('supplier-cost-5x-v1');
alter table apiwild_finance.customer_billing_policy enable row level security;
revoke all on apiwild_finance.customer_billing_policy from public,anon,authenticated,service_role;
create function apiwild_finance.cost5_active(at_time timestamptz) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from apiwild_finance.customer_billing_policy where id='supplier-cost-5x-v1' and effective_at is not null and at_time>=effective_at);
$$;
create function public.apiwild_customer_billing_policy() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',id,'effectiveAt',effective_at,'active',apiwild_finance.cost5_active(clock_timestamp()),'multiplier',multiplier,'extraFeeUsdMicros',extra_fee_usd_micros) from apiwild_finance.customer_billing_policy;
$$;
revoke all on function apiwild_finance.cost5_active(timestamptz),public.apiwild_customer_billing_policy() from public,anon,authenticated,service_role;
grant execute on function public.apiwild_customer_billing_policy() to service_role;
create function apiwild_finance.billing_policy_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='DELETE' or old.effective_at is not null then raise exception 'billing_policy_immutable';end if;
 if new.effective_at is null or new.effective_at<>date_trunc('second',new.effective_at) then raise exception 'billing_policy_second_required';end if;
 return new;
end;$$;
create trigger customer_billing_policy_immutable before update or delete on apiwild_finance.customer_billing_policy for each row execute function apiwild_finance.billing_policy_immutable();
revoke all on function apiwild_finance.billing_policy_immutable() from public,anon,authenticated,service_role;

-- Pin the billing identity at admission, never at later reconciliation.
create function apiwild_finance.pin_customer_billing_policy() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='reserved' and apiwild_finance.cost5_active(new.created_at) then
  new.usage_json:=coalesce(new.usage_json,'{}'::jsonb)||jsonb_build_object('billingPolicy','supplier-cost-5x-v1');
 end if;return new;
end;$$;
create trigger pin_customer_billing_policy before insert on apiwild_finance.gateway_requests for each row execute function apiwild_finance.pin_customer_billing_policy();
revoke all on function apiwild_finance.pin_customer_billing_policy() from public,anon,authenticated,service_role;

-- Keep USD reserved after the model response until authoritative cost arrives.
-- Preserve all deployed rate-version and concurrency predicates.
do $patch$
declare f text; definition text; before_pred text:='state in (''reserved'',''executing'',''uncertain'')'; after_pred text:='(state in (''reserved'',''executing'',''uncertain'') or usage_json->>''customerChargePending''=''true'')';
begin
 foreach f in array array['public.apiwild_gateway_reserve(text,uuid,uuid,text,text,text,text,text,bigint,bigint)','public.apiwild_gateway_claim(text,uuid,bigint)','public.apiwild_gateway_usage(text)','public.apiwild_billing_read(text,text)','apiwild_finance.enforce_workspace_policy()'] loop
  definition:=pg_get_functiondef(f::regprocedure);
  if position(before_pred in definition)=0 then raise exception 'billing_hold_definition_unexpected: %',f;end if;
  execute replace(definition,before_pred,after_pred);
 end loop;
end $patch$;

-- Actual supplier spend is billable even when the provider returned a failure.
-- Historic failed requests remain free; only verified cost5 settlements qualify.
do $patch$
declare constraint_name text; definition text;
begin
 select conname into strict constraint_name from pg_constraint where conrelid='apiwild_finance.gateway_requests'::regclass and contype='c' and position('failed' in pg_get_constraintdef(oid))>0 and position('cost_usd_micros' in pg_get_constraintdef(oid))>0;
 execute format('alter table apiwild_finance.gateway_requests drop constraint %I',constraint_name);
 alter table apiwild_finance.gateway_requests add constraint gateway_failed_verified_cost check(state<>'failed' or cost_usd_micros=0 or coalesce(usage_json->>'billingPolicy'='supplier-cost-5x-v1' and usage_json->>'customerChargePending'='false' and (usage_json->>'supplierUsdMicros')::bigint*5=cost_usd_micros,false));
 definition:=pg_get_functiondef('public.apiwild_gateway_usage(text)'::regprocedure);
 if position('sum(cost_usd_micros) filter(where state=''succeeded'')' in definition)=0 then raise exception 'usage_spend_definition_unexpected';end if;
 execute replace(definition,'sum(cost_usd_micros) filter(where state=''succeeded'')','sum(cost_usd_micros) filter(where state in (''succeeded'',''failed''))');
end $patch$;

-- Old requests retain their original pricing. New requests settle zero initially,
do $patch$
declare definition text;
begin
 definition:=pg_get_functiondef('apiwild_finance.reservation_expiry_list(text,uuid[],timestamptz,uuid)'::regprocedure);
 if position('r.usage_json=''{}''::jsonb' in definition)=0 then raise exception 'expiry_list_definition_unexpected';end if;
 execute replace(definition,'r.usage_json=''{}''::jsonb',$inject$(r.usage_json='{}'::jsonb or r.usage_json='{"billingPolicy":"supplier-cost-5x-v1"}'::jsonb)$inject$);
 definition:=pg_get_functiondef('public.apiwild_gateway_expire(text,uuid,bigint)'::regprocedure);
 if position('r.usage_json<>''{}''::jsonb' in definition)=0 then raise exception 'expiry_definition_unexpected';end if;
 execute replace(definition,'r.usage_json<>''{}''::jsonb',$inject$(r.usage_json<>'{}'::jsonb and r.usage_json<>'{"billingPolicy":"supplier-cost-5x-v1"}'::jsonb)$inject$);
end $patch$;

-- Old requests retain their original pricing. New requests settle zero initially,
-- retaining the complete USD hold via customerChargePending until receipt import.
do $patch$
declare definition text;
begin
 definition:=pg_get_functiondef('public.apiwild_gateway_finish_retail(text,uuid,bigint,text,bigint,bigint,text,jsonb,jsonb)'::regprocedure);
 if position('outcome:=public.apiwild_gateway_finish(' in definition)=0 then raise exception 'billing_finish_definition_unexpected';end if;
 definition:=replace(definition,'outcome:=public.apiwild_gateway_finish(',
 $inject$if r.usage_json->>'billingPolicy'='supplier-cost-5x-v1' then
  p_cost_usd_micros:=0;
  p_usage:=p_usage||jsonb_build_object('billingPolicy','supplier-cost-5x-v1','customerChargePending',true,'supplierReconciliationPending',true,'extraFeeUsdMicros',0);
 end if;
 outcome:=public.apiwild_gateway_finish($inject$);
 execute definition;
end $patch$;

-- Native quota is denominated in USD: 500000 quota = $1 supplier cost.
-- Therefore quota * 10 = customer USD micros at 5x, with no FX rounding loss.
do $patch$
declare definition text; old_charge text;
begin
 definition:=pg_get_functiondef('public.apiwild_native_import(uuid,uuid,jsonb)'::regprocedure);
 old_charge:='usd:=ceil(((f->>''prompt'')::numeric*(rate->>''input'')::numeric+(f->>''completion'')::numeric*(rate->>''output'')::numeric)/1000000);';
 if position(old_charge in definition)=0 then
  old_charge:='usd:=apiwild_finance.native_tariff_charge(rate,f->>''model'',(f->>''prompt'')::bigint,(f->>''completion'')::bigint,(f->>''created'')::bigint);';
 end if;
 if position(old_charge in definition)=0 then raise exception 'native_charge_definition_unexpected';end if;
 definition:=replace(definition,old_charge,$inject$if apiwild_finance.cost5_active(to_timestamp((f->>'created')::bigint)) then
   usd:=(f->>'quota')::bigint*10;
  else
   $inject$||old_charge||$inject$
  end if;$inject$);
 definition:=replace(definition,'''nativeLogId'',(f->>''id'')::bigint)',
 $inject$'nativeLogId',(f->>'id')::bigint,'billingPolicy',case when apiwild_finance.cost5_active(to_timestamp((f->>'created')::bigint)) then 'supplier-cost-5x-v1' else 'reference-token-v1' end,'supplierUsdMicros',(f->>'quota')::bigint*2,'extraFeeUsdMicros',0)$inject$);
 execute definition;
end $patch$;

-- The existing receipt validator establishes native quota, account, provider,
-- identity and FX evidence before this settlement hook executes.
create function apiwild_finance.settle_customer_cost5(p_owner text,p_request uuid,p_fact jsonb,p_check_only boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare r apiwild_finance.gateway_requests; quota bigint; usd bigint;
begin
 r:=apiwild_finance.lock_request(p_owner,p_request);
 if r.usage_json->>'billingPolicy' is distinct from 'supplier-cost-5x-v1' then return true;end if;
 if p_fact->'native_debit'->>'quota_per_unit' is distinct from '500000'
 or p_fact->'native_debit'->>'quota_unit_currency' is distinct from 'USD'
 or coalesce(p_fact->'native_debit'->>'quota','') !~ '^[0-9]+$' then raise exception 'billing_native_quota_required';end if;
 quota:=(p_fact->'native_debit'->>'quota')::bigint;usd:=quota*10;
 if usd<0 or usd>r.reserved_usd_micros then
  update apiwild_finance.provider_budgets set accepted=false where id=r.provider_budget_id;
  update apiwild_finance.gateway_requests set pricing_bound_exceeded=true where id=p_request;
  return false;
 end if;
 if p_check_only then return true;end if;
 update apiwild_finance.gateway_requests set cost_usd_micros=usd,
  usage_json=usage_json||jsonb_build_object('customerChargePending',false,'supplierReconciliationPending',false,'supplierUsdMicros',quota*2,'billingMultiplier',5,'extraFeeUsdMicros',0),updated_at=clock_timestamp()
  where id=p_request returning * into r;
 update apiwild_finance.gateway_outbox set payload=payload||jsonb_build_object('cost_usd_micros',usd,'usage',r.usage_json) where request_id=p_request;
 return true;
end;$$;
revoke all on function apiwild_finance.settle_customer_cost5(text,uuid,jsonb,boolean) from public,anon,authenticated,service_role;
do $patch$
declare definition text; needle text;
begin
 definition:=pg_get_functiondef('apiwild_finance.supplier_debit_apply(text,uuid,jsonb,text)'::regprocedure);
 needle:='result:=public.apiwild_gateway_reconcile_supplier(p_owner,p_request,cost,''subrouter:''||(p_fact->>''receipt_id''));';
 if position(needle in definition)=0 or position('native_debit' in definition)=0 then raise exception 'supplier_apply_definition_unexpected';end if;
 definition:=replace(definition,needle,
 $inject$if not apiwild_finance.settle_customer_cost5(p_owner,p_request,p_fact,true) then return jsonb_build_object('reconciled',false,'reason','customer_bound_exceeded');end if;
  result:=public.apiwild_gateway_reconcile_supplier(p_owner,p_request,cost,'subrouter:'||(p_fact->>'receipt_id'));
  if (result->>'reconciled')::boolean then perform apiwild_finance.settle_customer_cost5(p_owner,p_request,p_fact,false);end if;$inject$);
 execute definition;
end $patch$;
-- $1 maximum customer allowance at 5x = $0.20 supplier = CNY 1.36.
-- The existing shared provider budget still bounds every allocation.
do $patch$
declare definition text;
begin
 definition:=pg_get_functiondef('public.apiwild_native_allocate(uuid,uuid,bigint,bigint)'::regprocedure);
 if position('p_cny not between 1 and 68000' in definition)=0 then raise exception 'native_allowance_definition_unexpected';end if;
 execute replace(definition,'p_cny not between 1 and 68000','p_cny not between 1 and 1360000');
end $patch$;
commit;

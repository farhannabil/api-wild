-- CLI-generated migration: persist the full DeepSeek retail tier in the request
-- version while matching only the accepted base version in provider budgets.
-- It enables no models, budgets, credentials or tariffs by itself.
begin;
create function apiwild_finance.gateway_budget_rate_matches(p_budget text,p_request text,p_model text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select case when p_model in ('deepseek-v4-flash','deepseek-v4-pro') then
   p_budget ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,139}$'
   and p_request in (p_budget||':ds26:peak',p_budget||':ds26:off_peak')
 else p_budget=p_request and position(':ds26:' in p_request)=0 end;
$$;
revoke all on function apiwild_finance.gateway_budget_rate_matches(text,text,text) from public,anon,authenticated,service_role;

-- Amend only the provider-budget comparison of the installed, current
-- functions. Preserve nullable-key guards, full-version idempotency, request
-- snapshots and every existing customer/workspace/supplier control.
-- Fail the transaction if an unreviewed definition does not contain exactly
-- the expected predicate; never overwrite an unknown deployed function body.
do $$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('public.apiwild_gateway_reserve(text,uuid,uuid,text,text,text,text,text,bigint,bigint)'::regprocedure);
 needle:='b.rate_version<>p_rate_version';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
   or position('r.rate_version<>p_rate_version' in definition)=0
   or position('k.total_limit_usd_micros is not null' in definition)=0
 then raise exception 'unreviewed_gateway_reserve_definition';end if;
 replacement:='not apiwild_finance.gateway_budget_rate_matches(b.rate_version,p_rate_version,p_model)';
 execute replace(definition,needle,replacement);
 definition:=pg_get_functiondef('public.apiwild_gateway_claim(text,uuid,bigint)'::regprocedure);
 needle:='b.rate_version<>r.rate_version';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
   or position('k.revoked_at is not null' in definition)=0
 then raise exception 'unreviewed_gateway_claim_definition';end if;
 replacement:='not apiwild_finance.gateway_budget_rate_matches(b.rate_version,r.rate_version,r.model)';
 execute replace(definition,needle,replacement);
end;
$$;
-- Exact replay quote only: no result, usage, provider credentials or write.
-- Owner/key/capability/payload are rechecked; changed inputs are conflicts.
create function apiwild_finance.gateway_quote_lookup(p_owner text,p_key_id uuid,p_request_key text,p_payload_hash text,p_capability text,p_model text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare r apiwild_finance.gateway_requests;k apiwild_finance.gateway_keys;
begin
 if current_setting('role',true)<>'service_role' or auth.uid() is not null then raise exception 'gateway_server_only';end if;
 if p_owner is null or p_owner!~'^(live|test):supabase:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or p_request_key is null or p_request_key!~'^[A-Za-z0-9_-]{16,100}$'
  or p_payload_hash is null or p_payload_hash!~'^[a-f0-9]{64}$'
  or p_capability is null or p_capability not in ('chat','code','research','voice','transcribe','speak')
  or p_model is null or length(p_model) not between 1 and 160 then raise exception 'gateway_invalid_input';end if;
 perform apiwild_finance.assert_customer(p_owner);
 if p_key_id is not null then
  select * into k from apiwild_finance.gateway_keys where id=p_key_id;
  if not found or k.user_id<>p_owner or k.revoked_at is not null
    or (k.expires_at is not null and k.expires_at<=clock_timestamp()) or not p_capability=any(k.scopes)
  then raise exception 'gateway_key_unavailable';end if;
 end if;
 select * into r from apiwild_finance.gateway_requests where user_id=p_owner and request_key=p_request_key;
 if not found then return jsonb_build_object('found',false);end if;
 if r.key_id is distinct from p_key_id or r.payload_hash<>p_payload_hash or r.capability<>p_capability or r.model<>p_model
 then raise exception 'gateway_idempotency_conflict';end if;
 return jsonb_build_object('found',true,'quote',jsonb_build_object('providerBudgetId',r.provider_budget_id,'model',r.model,
  'rateVersion',r.rate_version,'reservedUsdMicros',r.reserved_usd_micros,'reservedCnyMicros',r.reserved_cny_micros));
end;
$$;
create function public.apiwild_gateway_quote_lookup(p_owner text,p_key_id uuid,p_request_key text,p_payload_hash text,p_capability text,p_model text)
returns jsonb language sql security invoker set search_path='' as $$
 select apiwild_finance.gateway_quote_lookup(p_owner,p_key_id,p_request_key,p_payload_hash,p_capability,p_model);
$$;
revoke all on function apiwild_finance.gateway_quote_lookup(text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function apiwild_finance.gateway_quote_lookup(text,uuid,text,text,text,text) to service_role;
grant usage on schema apiwild_finance to service_role;
revoke all on function public.apiwild_gateway_quote_lookup(text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.apiwild_gateway_quote_lookup(text,uuid,text,text,text,text) to service_role;
commit;

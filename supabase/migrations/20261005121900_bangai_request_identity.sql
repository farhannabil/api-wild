-- Exactly four reviewed bangai pairs; UUID default and financial guards preserved.
-- Existing function grants remain unchanged. No data, budgets or routes are modified.
begin;
-- Keep background discovery aligned with the same exact identity contract.
create or replace function apiwild_finance.supplier_pending_list(p_billing_mode text,p_key_references uuid[],p_after_created_at timestamptz,p_after_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 perform apiwild_finance.allowance_assert_server();
 if p_billing_mode is null or p_billing_mode not in ('live','test') or p_key_references is null
  or cardinality(p_key_references) not between 1 and 2 or array_position(p_key_references,null) is not null
  or (p_after_created_at is null)<>(p_after_id is null) then raise exception 'supplier_invalid_scan';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('owner',q.user_id,'requestId',q.id,'createdAt',q.created_at) order by q.created_at,q.id)
  from(select r.id,r.user_id,r.created_at from apiwild_finance.gateway_requests r
   join apiwild_finance.provider_budgets b on b.id=r.provider_budget_id
   where b.product='apiwild' and b.billing_mode=p_billing_mode and b.key_reference=any(p_key_references)
    and r.user_id like p_billing_mode||':supabase:%' and r.supplier_pending and r.state in ('succeeded','failed')
    and r.created_at >= (date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')
    and r.created_at <= clock_timestamp()
    and ((r.usage_json->>'providerRequestId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or ((r.usage_json->>'providerRequestId') ~ '^[0-9a-f]{8}$'
      and r.usage_json->>'supplierSlug' is not distinct from 'bangai'
      and r.model in ('claude-opus-4-6','claude-opus-4-7','gpt-6-astra','gpt-6-sol')))
    and r.settlement_reference='usage:'||(r.usage_json->>'providerRequestId')
    and (p_after_created_at is null or (r.created_at,r.id)>(p_after_created_at,p_after_id))
   order by r.created_at,r.id limit 5) q),'[]'::jsonb);
end;$$;

create or replace function apiwild_finance.supplier_request_read(p_owner text,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare r apiwild_finance.gateway_requests;b apiwild_finance.provider_budgets;correlation text;
begin
 perform apiwild_finance.allowance_assert_server();
 if p_owner is null or p_owner !~ '^(live|test):supabase:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or p_request is null then raise exception 'supplier_invalid_reference';end if;
 select * into r from apiwild_finance.gateway_requests where id=p_request and user_id=p_owner;
 if not found or r.state not in ('succeeded','failed') or not r.supplier_pending then return null;end if;
 select * into b from apiwild_finance.provider_budgets where id=r.provider_budget_id and billing_mode=split_part(p_owner,':',1) and product='apiwild';
 if not found then return null;end if;
 correlation:=r.usage_json->>'providerRequestId';
 if correlation is null or not(correlation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or (correlation ~ '^[0-9a-f]{8}$' and r.usage_json->>'supplierSlug' is not distinct from 'bangai'
   and r.model in ('claude-opus-4-6','claude-opus-4-7','gpt-6-astra','gpt-6-sol')))
  or r.settlement_reference is distinct from 'usage:'||correlation then return null;end if;
 return jsonb_build_object('owner',p_owner,'requestId',r.id,'keyReference',b.key_reference,
  'model',r.model,'upstreamResponseId',correlation,'supplierPending',true);
end;$$;
create or replace function apiwild_finance.supplier_debit_apply(p_owner text,p_request uuid,p_fact jsonb,p_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r apiwild_finance.gateway_requests;b apiwild_finance.provider_budgets;old apiwild_finance.supplier_debit_receipts;
 result jsonb;cost bigint;n jsonb;field text;observed timestamptz;valid_until timestamptz;settings_text text;
begin
 perform apiwild_finance.allowance_assert_server();
 if p_fact is null or jsonb_typeof(p_fact)<>'object' or octet_length(p_fact::text)>4096 or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
  or p_fact-'receipt_id'-'key_reference'-'upstream_response_id'-'model'-'currency'-'cost_cny_micros'-'native_debit'<>'{}'::jsonb
  or jsonb_typeof(p_fact->'cost_cny_micros') is distinct from 'number' or (p_fact->>'cost_cny_micros') !~ '^[0-9]+$'
  or p_fact->>'currency' is distinct from 'CNY' or length(p_fact->>'receipt_id') not between 1 and 200
  or p_fact->>'receipt_id' ~ '[[:cntrl:][:space:]]' or p_fact->>'receipt_id' is null then raise exception 'supplier_invalid_receipt';end if;
 cost:=(p_fact->>'cost_cny_micros')::bigint;if cost not between 0 and 1000000000000 then raise exception 'supplier_invalid_cost';end if;
 if p_fact?'native_debit' then
  n:=p_fact->'native_debit';
  if jsonb_typeof(n) is distinct from 'object' or n-'quota'-'quota_unit_currency'-'quota_per_unit'-'price'-'usd_exchange_rate'
   -'quota_display_type'-'display_in_currency'-'settings_observed_at'-'settings_valid_until'-'settings_sha256'
   -'log_id'-'log_created_at'-'account_user_id'-'token_id'-'provider_slug'-'billing_source'-'billing_multiplier'<>'{}'::jsonb
   or not(n ?& array['quota','quota_unit_currency','quota_per_unit','price','usd_exchange_rate','quota_display_type','display_in_currency',
    'settings_observed_at','settings_valid_until','settings_sha256','log_id','log_created_at','account_user_id','token_id','provider_slug','billing_source','billing_multiplier'])
   or n->>'quota_unit_currency' is distinct from 'USD' or n->'quota_per_unit' is distinct from '500000'::jsonb
   or n->>'quota_display_type' is distinct from 'CNY' or n->'display_in_currency' is distinct from 'true'::jsonb
   or n->>'billing_source' is distinct from 'wallet' or n->'billing_multiplier' is distinct from '1'::jsonb
   or jsonb_typeof(n->'price') is distinct from 'string' or jsonb_typeof(n->'usd_exchange_rate') is distinct from 'string'
   or n->>'price' !~ '^(0|[1-9][0-9]{0,2})(\.[0-9]{0,5}[1-9])?$' or (n->>'price')::numeric<=0
   or n->>'price' is distinct from n->>'usd_exchange_rate'
   or n->>'provider_slug' !~ '^[a-z0-9][a-z0-9_-]{0,99}$'
   or n->>'settings_sha256' !~ '^[a-f0-9]{64}$'
   or n->>'settings_observed_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
   or n->>'settings_valid_until' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
   then raise exception 'supplier_invalid_native_audit';end if;
  foreach field in array array['quota','log_id','log_created_at','account_user_id','token_id'] loop
   if jsonb_typeof(n->field) is distinct from 'number' or n->>field !~ '^[0-9]+$'
    or (n->>field)::numeric not between (case when field='quota' then 0 else 1 end) and 9007199254740991
    then raise exception 'supplier_invalid_native_audit';end if;
  end loop;
  foreach field in array array['provider_slug','settings_sha256','settings_observed_at','settings_valid_until'] loop
   if jsonb_typeof(n->field) is distinct from 'string' then raise exception 'supplier_invalid_native_audit';end if;
  end loop;
  observed:=(n->>'settings_observed_at')::timestamptz;valid_until:=(n->>'settings_valid_until')::timestamptz;
  if valid_until<=observed or valid_until-observed>interval '30 days'
   or (n->>'log_created_at')::numeric<floor(extract(epoch from observed))
   or (n->>'log_created_at')::numeric>=ceil(extract(epoch from valid_until))
   or cost<>ceil((n->>'quota')::numeric*(n->>'usd_exchange_rate')::numeric*1000000/500000)
   then raise exception 'supplier_invalid_normalized_cost';end if;
  settings_text:='["subrouter-status-v1",500000,"CNY",true,"'||(n->>'price')||'","'||(n->>'usd_exchange_rate')||'"]';
  if encode(sha256(convert_to(settings_text,'UTF8')),'hex') is distinct from n->>'settings_sha256'
   then raise exception 'supplier_invalid_settings_digest';end if;
 end if;
 r:=apiwild_finance.lock_request(p_owner,p_request);
 -- Short correlation IDs require the same recorded approved pair and actual native audit.
 if p_fact->>'upstream_response_id' ~ '^[0-9a-f]{8}$' and (
  r.usage_json->>'supplierSlug' is distinct from 'bangai'
  or r.model not in ('claude-opus-4-6','claude-opus-4-7','gpt-6-astra','gpt-6-sol')
  or not(p_fact?'native_debit') or p_fact->'native_debit'->>'provider_slug' is distinct from 'bangai')
  then raise exception 'supplier_receipt_provider_mismatch';end if;
 select * into b from apiwild_finance.provider_budgets where id=r.provider_budget_id;
 if p_fact->>'key_reference' is distinct from b.key_reference::text or p_fact->>'model' is distinct from r.model
  or r.settlement_reference is distinct from 'usage:'||(p_fact->>'upstream_response_id')
  or r.state not in ('succeeded','failed')
  or (p_fact?'native_debit' and (r.usage_json->>'providerRequestId' is distinct from p_fact->>'upstream_response_id'))
  then raise exception 'supplier_receipt_owner_mismatch';end if;
 select * into old from apiwild_finance.supplier_debit_receipts where request_id=p_request;
 if found then
  if old.user_id<>p_owner or old.fact<>p_fact or old.digest<>p_digest then raise exception 'supplier_receipt_conflict';end if;
  return jsonb_build_object('reconciled',old.reconciled,'replayed',true);
 end if;
 result:=public.apiwild_gateway_reconcile_supplier(p_owner,p_request,cost,'subrouter:'||(p_fact->>'receipt_id'));
 insert into apiwild_finance.supplier_debit_receipts(request_id,user_id,key_reference,receipt_id,fact,digest,reconciled)
  values(p_request,p_owner,b.key_reference,p_fact->>'receipt_id',p_fact,p_digest,(result->>'reconciled')::boolean);
 return result||jsonb_build_object('replayed',false);
end;$$;
commit;

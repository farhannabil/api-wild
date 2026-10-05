-- Bounded read-only current-UTC-day candidates; cursor belongs to one worker.
begin;
create function apiwild_finance.supplier_pending_list(p_billing_mode text,p_key_references uuid[],p_after_created_at timestamptz,p_after_id uuid)
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
    and (r.usage_json->>'providerRequestId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and r.settlement_reference='usage:'||(r.usage_json->>'providerRequestId')
    and (p_after_created_at is null or (r.created_at,r.id)>(p_after_created_at,p_after_id))
   order by r.created_at,r.id limit 5) q),'[]'::jsonb);
end;$$;
create function public.apiwild_supplier_pending_list(p_billing_mode text,p_key_references uuid[],p_after_created_at timestamptz,p_after_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select apiwild_finance.supplier_pending_list(p_billing_mode,p_key_references,p_after_created_at,p_after_id);$$;
revoke all on function apiwild_finance.supplier_pending_list(text,uuid[],timestamptz,uuid),public.apiwild_supplier_pending_list(text,uuid[],timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function apiwild_finance.supplier_pending_list(text,uuid[],timestamptz,uuid),public.apiwild_supplier_pending_list(text,uuid[],timestamptz,uuid) to service_role;
commit;

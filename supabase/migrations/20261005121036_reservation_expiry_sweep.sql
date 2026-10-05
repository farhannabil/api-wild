-- Read-only finite candidates; cancellation still uses the existing locked CAS RPC.
begin;
create function apiwild_finance.reservation_expiry_list(p_billing_mode text,p_key_references uuid[],p_after_expires_at timestamptz,p_after_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 perform apiwild_finance.allowance_assert_server();
 if p_billing_mode is null or p_billing_mode not in ('live','test') or p_key_references is null
  or cardinality(p_key_references) not between 1 and 2 or array_position(p_key_references,null) is not null
  or (select count(distinct k) from unnest(p_key_references) k)<>cardinality(p_key_references)
  or (p_after_expires_at is null)<>(p_after_id is null) then raise exception 'expiry_invalid_scan';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('owner',q.user_id,'requestId',q.id,'expiresAt',q.expires_at,'version',q.version) order by q.expires_at,q.id)
  from(select r.id,r.user_id,r.expires_at,r.version from apiwild_finance.gateway_requests r
   join apiwild_finance.provider_budgets b on b.id=r.provider_budget_id
   where b.product='apiwild' and b.billing_mode=p_billing_mode and b.key_reference=any(p_key_references)
    and r.user_id like p_billing_mode||':supabase:%' and r.state='reserved' and r.expires_at<=clock_timestamp()
    and not r.supplier_pending and not r.pricing_bound_exceeded and r.cost_usd_micros=0 and r.cost_cny_micros=0 and r.observed_cny_micros=0
    and r.settlement_reference is null and r.result_json is null and r.usage_json='{}'::jsonb
    and (p_after_expires_at is null or (r.expires_at,r.id)>(p_after_expires_at,p_after_id))
   order by r.expires_at,r.id limit 5) q),'[]'::jsonb);
end;$$;
create function public.apiwild_reservation_expiry_list(p_billing_mode text,p_key_references uuid[],p_after_expires_at timestamptz,p_after_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select apiwild_finance.reservation_expiry_list(p_billing_mode,p_key_references,p_after_expires_at,p_after_id);$$;
revoke all on function apiwild_finance.reservation_expiry_list(text,uuid[],timestamptz,uuid),public.apiwild_reservation_expiry_list(text,uuid[],timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function apiwild_finance.reservation_expiry_list(text,uuid[],timestamptz,uuid),public.apiwild_reservation_expiry_list(text,uuid[],timestamptz,uuid) to service_role;

-- Recheck evidence under the existing account/budget/request locks, not just at scan time.
create or replace function public.apiwild_gateway_expire(p_owner text,p_id uuid,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r apiwild_finance.gateway_requests;
begin
 perform apiwild_finance.allowance_assert_server();
 if p_expected_version is null or p_expected_version not between 0 and 9007199254740990 then raise exception 'gateway_invalid_version';end if;
 r:=apiwild_finance.lock_request(p_owner,p_id);
 if r.state<>'reserved' or r.version<>p_expected_version or r.expires_at>clock_timestamp()
  or r.supplier_pending or r.pricing_bound_exceeded or r.cost_usd_micros<>0 or r.cost_cny_micros<>0 or r.observed_cny_micros<>0
  or r.settlement_reference is not null or r.result_json is not null or r.usage_json<>'{}'::jsonb
  then return jsonb_build_object('cancelled',false,'record',to_jsonb(r));end if;
 update apiwild_finance.gateway_requests set state='cancelled',version=version+1,updated_at=clock_timestamp() where id=p_id returning * into r;
 return jsonb_build_object('cancelled',true,'record',to_jsonb(r));
end;$$;
revoke all on function public.apiwild_gateway_expire(text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.apiwild_gateway_expire(text,uuid,bigint) to service_role;
commit;

begin;
create or replace function public.apiwild_native_key_prepare(p_owner text,p_id uuid,p_hash text,p_daily bigint,p_total bigint,p_expires timestamptz,p_budget uuid,p_account bigint,p_rates jsonb)
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
 insert into apiwild_finance.native_customer_keys(key_id,provider_budget_id,account_id,token_name,rates) values(p_id,p_budget,p_account,'aw-'||left(replace(p_id::text,'-',''),24),p_rates);
 return v;
end; $$;
commit;

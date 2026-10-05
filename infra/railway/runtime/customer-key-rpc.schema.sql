-- REVIEWED CANDIDATE ONLY: apply after the existing gateway portability migration.
-- Service-only lifecycle. No funded balances, provider acceptance or supplier secrets.
begin;
create or replace function apiwild_finance.gateway_key_metadata(k apiwild_finance.gateway_keys)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',k.id,'customer_id',a.customer_id,'billing_mode',a.billing_mode,
 'scopes',k.scopes,'daily_limit_usd_micros',k.daily_limit_usd_micros,
 'total_limit_usd_micros',k.total_limit_usd_micros,'expires_at',k.expires_at,'revoked_at',k.revoked_at)
 from apiwild_finance.gateway_accounts a where a.user_id=k.user_id;
$$;
revoke all on function apiwild_finance.gateway_key_metadata(apiwild_finance.gateway_keys) from public,anon,authenticated,service_role;

create or replace function public.apiwild_gateway_key_issue(p_owner text,p_id uuid,p_hash text,p_scopes text[],p_daily_limit bigint,p_total_limit bigint,p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
declare k apiwild_finance.gateway_keys;
begin
 if p_id is null or p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_scopes is null
 or cardinality(p_scopes) not between 1 and 6 or array_position(p_scopes,null) is not null
 or not p_scopes<@array['chat','code','research','voice','transcribe','speak']::text[]
 or cardinality(p_scopes)<>(select count(distinct s) from unnest(p_scopes) s)
 or p_daily_limit is null or p_total_limit is null or p_daily_limit not between 0 and 1000000000000
 or p_total_limit not between 0 and 1000000000000 or p_daily_limit>p_total_limit
 or p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '365 days'
 then raise exception 'gateway_key_invalid_input'; end if;
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 perform apiwild_finance.assert_customer(p_owner);
 if (select count(*) from apiwild_finance.gateway_keys where user_id=p_owner)>=100 then raise exception 'gateway_key_count_limit'; end if;
 insert into apiwild_finance.gateway_keys(id,user_id,hash,scopes,daily_limit_usd_micros,total_limit_usd_micros,expires_at)
 values(p_id,p_owner,p_hash,p_scopes,p_daily_limit,p_total_limit,p_expires_at) returning * into k;
 return apiwild_finance.gateway_key_metadata(k);
end;
$$;

create or replace function public.apiwild_gateway_key_list(p_owner text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
begin
 perform apiwild_finance.assert_customer(p_owner);
 return coalesce((select jsonb_agg(apiwild_finance.gateway_key_metadata(k) order by k.id) from apiwild_finance.gateway_keys k where k.user_id=p_owner),'[]'::jsonb);
end;
$$;

create or replace function public.apiwild_gateway_key_revoke(p_owner text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
declare k apiwild_finance.gateway_keys;
begin
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 perform apiwild_finance.assert_customer(p_owner);
 update apiwild_finance.gateway_keys set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=p_id and user_id=p_owner returning * into k;
 if not found then raise exception 'gateway_key_unavailable'; end if;
 return apiwild_finance.gateway_key_metadata(k);
end;
$$;

create or replace function public.apiwild_gateway_key_authenticate(p_hash text,p_mode text,p_capability text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare k apiwild_finance.gateway_keys;
begin
 if p_hash is null or p_hash!~'^[a-f0-9]{64}$' or p_mode is null or p_mode not in ('test','live')
 or p_capability is null or p_capability not in ('chat','code','research','voice','transcribe','speak') then raise exception 'gateway_key_unavailable'; end if;
 select x.* into k from apiwild_finance.gateway_keys x join apiwild_finance.gateway_accounts a on a.user_id=x.user_id
 where x.hash=p_hash and a.billing_mode=p_mode and x.revoked_at is null and x.expires_at>clock_timestamp() and p_capability=any(x.scopes);
 if not found then raise exception 'gateway_key_unavailable'; end if;
 perform apiwild_finance.assert_customer(k.user_id);
 return apiwild_finance.gateway_key_metadata(k);
end;
$$;
revoke all on function public.apiwild_gateway_key_issue(text,uuid,text,text[],bigint,bigint,timestamptz),public.apiwild_gateway_key_list(text),public.apiwild_gateway_key_revoke(text,uuid),public.apiwild_gateway_key_authenticate(text,text,text) from public,anon,authenticated;
grant execute on function public.apiwild_gateway_key_issue(text,uuid,text,text[],bigint,bigint,timestamptz),public.apiwild_gateway_key_list(text),public.apiwild_gateway_key_revoke(text,uuid),public.apiwild_gateway_key_authenticate(text,text,text) to service_role;
commit;

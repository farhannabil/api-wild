-- Database-owner acceptance. Isolated records always roll back; no provider API.
begin;
set local statement_timeout='30s';set local lock_timeout='5s';
do $fixture$
declare customer uuid:=gen_random_uuid();budget uuid:=gen_random_uuid();keyid uuid:=gen_random_uuid();runid uuid:=gen_random_uuid();ownerid text;
 native_account bigint:=1000000000000+floor(random()*1000000000000)::bigint;
 native_token bigint:=1000000000000+floor(random()*1000000000000)::bigint;
 rates jsonb; receipts jsonb;result jsonb;spent bigint;rejected boolean:=false;
begin
 ownerid:='live:supabase:'||customer;
 rates:='{"deepseek-v4.1-flash":{"input":90000,"output":350000,"provider":"fixture-provider","processing":"off_peak","peak":{"input":150000,"output":760000},"calendar":"cn-state-council-2026-7","validFrom":1791763200,"validUntil":1793787919}}';
 if apiwild_finance.native_tariff_charge(rates->'deepseek-v4.1-flash','deepseek-v4.1-flash',1000000,1000000,extract(epoch from '2026-10-12T02:00:00Z'::timestamptz)::bigint)<>910000 then raise exception 'peak_wrong';end if;
 if apiwild_finance.native_tariff_charge(rates->'deepseek-v4.1-flash','deepseek-v4.1-flash',1000000,1000000,extract(epoch from '2026-10-12T04:00:00Z'::timestamptz)::bigint)<>440000 then raise exception 'off_peak_wrong';end if;
 begin perform apiwild_finance.native_tariff_charge((rates->'deepseek-v4.1-flash')-'validUntil','deepseek-v4.1-flash',1,1,1791853200);
 exception when others then if sqlerrm<>'native_tier_invalid' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'missing_window_accepted';end if;
 insert into auth.users(id,email_confirmed_at,is_anonymous) values(customer,clock_timestamp(),false);
 insert into public.customer_profiles(user_id,onboarding_completed_at) values(customer,clock_timestamp()) on conflict(user_id) do update set onboarding_completed_at=excluded.onboarding_completed_at;
 perform public.apiwild_gateway_account_initialize(ownerid);
 insert into apiwild_finance.provider_budgets(id,product,billing_mode,currency,key_reference,accepted,total_limit_cny_micros,daily_limit_cny_micros,rate_version,models)
 values(budget,'apiwild','live','CNY',gen_random_uuid(),true,100000,100000,'apiwild-launch-20261005',array['deepseek-v4.1-flash']);
 perform public.apiwild_native_key_prepare(ownerid,keyid,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),null,null,null,budget,native_account,rates);
 perform public.apiwild_native_key_attach(ownerid,keyid,native_token);
 -- Model a key that already existed at both historic receipt times.
 update apiwild_finance.native_customer_keys set created_at='2026-10-12T00:00:00Z' where key_id=keyid;
 if not public.apiwild_native_sync_claim(keyid,runid) then raise exception 'claim_wrong';end if;
 perform public.apiwild_native_sync_finish(keyid,runid,0);
 update apiwild_finance.gateway_accounts set funded_usd_micros=3000000 where user_id=ownerid;
 perform public.apiwild_native_allocate(keyid,runid,1000000,5000);
 receipts:=jsonb_build_array(jsonb_build_object('id',1,'token',native_token,'account',native_account,'prompt',500000,'completion',500000,'quota',100,'created',extract(epoch from '2026-10-12T02:00:00Z'::timestamptz)::bigint,'model','deepseek-v4.1-flash','provider','fixture-provider'),jsonb_build_object('id',2,'token',native_token,'account',native_account,'prompt',500000,'completion',500000,'quota',100,'created',extract(epoch from '2026-10-12T04:00:00Z'::timestamptz)::bigint,'model','deepseek-v4.1-flash','provider','fixture-provider'));
 result:=public.apiwild_native_import(keyid,runid,receipts);if result->>'imported'<>'2' then raise exception 'import_wrong';end if;
 select sum(cost_usd_micros) into spent from apiwild_finance.gateway_requests where user_id=ownerid and state='succeeded';if spent<>675000 then raise exception 'retail_wrong:%',spent;end if;
 if (select count(distinct rate_version) from apiwild_finance.gateway_requests where user_id=ownerid and state='succeeded')<>2 then raise exception 'tiers_not_recorded';end if;
 result:=public.apiwild_native_import(keyid,runid,receipts);if result->>'imported'<>'0' then raise exception 'replay_wrong';end if;
end $fixture$;
rollback;
select 'deepseek_native_tiers_receipt_time_replay_and_window_guards_passed' as acceptance;

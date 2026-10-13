-- Production-schema acceptance, before activation only. Always rolls back.
begin;
set local statement_timeout='30s';
set local lock_timeout='5s';
do $fixture$
declare customer uuid:=gen_random_uuid(); ownerid text; budget uuid:=gen_random_uuid();
 keyid uuid:=gen_random_uuid(); runid uuid:=gen_random_uuid(); tokenid bigint:=1000000000000+floor(random()*1000000000000)::bigint;
 receipt jsonb; v jsonb; r jsonb; balance jsonb; gatewayid uuid;
begin
 update apiwild_finance.customer_billing_policy set effective_at=date_trunc('second',clock_timestamp())-interval '1 second' where id='supplier-cost-5x-v1';
 ownerid:='live:supabase:'||customer;
 insert into auth.users(id,email_confirmed_at,is_anonymous) values(customer,clock_timestamp(),false);
 insert into public.customer_profiles(user_id,onboarding_completed_at) values(customer,clock_timestamp()) on conflict(user_id) do update set onboarding_completed_at=excluded.onboarding_completed_at;
 perform public.apiwild_gateway_account_initialize(ownerid);
 update apiwild_finance.gateway_accounts set funded_usd_micros=25000000 where user_id=ownerid;
 insert into apiwild_finance.provider_budgets(id,product,billing_mode,currency,key_reference,accepted,total_limit_cny_micros,daily_limit_cny_micros,rate_version,models)
 values(budget,'apiwild','live','CNY',gen_random_uuid(),true,50000000,50000000,'cost5-fixture',array['claude-opus-4-6']);
 perform public.apiwild_native_key_prepare(ownerid,keyid,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),null,null,null,budget,tokenid,
 '{"claude-opus-4-6":{"input":2500000,"output":12500000,"provider":"fixture-provider"}}'::jsonb);
 perform public.apiwild_native_key_attach(ownerid,keyid,tokenid);
 perform public.apiwild_native_sync_claim(keyid,runid);
 receipt:=jsonb_build_object('id',1,'token',tokenid,'account',tokenid,'prompt',1000000,'completion',0,'quota',500000,'created',floor(extract(epoch from clock_timestamp())),'model','claude-opus-4-6','provider','fixture-provider');
 v:=public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt));
 if v->>'imported'<>'1' then raise exception 'fixture_import_failed';end if;
 v:=public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt));
 if v->>'imported'<>'0' then raise exception 'fixture_double_charge';end if;
 perform public.apiwild_native_sync_finish(keyid,runid,500000);
 v:=public.apiwild_gateway_usage(ownerid);
 if (v->>'spentUsdMicros')::bigint<>5000000 or (v->>'availableUsdMicros')::bigint<>20000000 then raise exception 'fixture_dollar_math_failed';end if;
 balance:=public.apiwild_billing_read(ownerid,null);
 if (balance->>'balanceCents')::bigint<>2000 then raise exception 'fixture_balance_disagrees';end if;
 r:=public.apiwild_gateway_reserve(ownerid,null,budget,'cost5_fixture_'||replace(gen_random_uuid()::text,'-',''),repeat('a',64),'chat','claude-opus-4-6','cost5-fixture',1000000,1360000);
 gatewayid:=(r->'record'->>'id')::uuid;
 r:=public.apiwild_gateway_claim(ownerid,gatewayid,(r->'record'->>'version')::bigint);
 perform public.apiwild_gateway_finish_retail(ownerid,gatewayid,(r->'record'->>'version')::bigint,'succeeded',123,0,'usage:fixture',jsonb_build_object('text','fixture'),jsonb_build_object('providerRequestId','fixture','supplierSlug','fixture-provider'));
 v:=public.apiwild_gateway_usage(ownerid);
 balance:=public.apiwild_billing_read(ownerid,null);
 if (v->>'spentUsdMicros')::bigint<>5000000 or (v->>'reservedUsdMicros')::bigint<>1000000 or (v->>'availableUsdMicros')::bigint<>19000000 or (balance->>'balanceCents')::bigint<>1900 then raise exception 'fixture_pending_hold_failed';end if;
 raise notice 'PASS: $25 funded, $1 supplier, $5 charge, $20 balance, duplicate suppressed, pending hold and billing/usage aligned';
end;
$fixture$;
rollback;

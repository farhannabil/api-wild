-- Run only after the native hourly migration, as a database owner.
-- This fixture creates isolated random records and ALWAYS rolls back.
-- No provider API, customer record, funding event, or email is dispatched.
begin;
set local statement_timeout='30s';
set local lock_timeout='5s';
do $fixture$
declare
 customer uuid:=gen_random_uuid(); budget uuid:=gen_random_uuid();
 keyid uuid:=gen_random_uuid(); runid uuid:=gen_random_uuid();
 ownerid text; native_account bigint; native_token bigint;
 receipt jsonb; result jsonb; usage_result jsonb; rejected boolean;
 cost_usd bigint; cost_cny bigint; leaseid uuid;
begin
 ownerid:='live:supabase:'||customer;
 -- Positive random bigint identifiers avoid collisions with real native IDs.
 native_account:=1000000000000+floor(random()*1000000000000)::bigint;
 native_token:=1000000000000+floor(random()*1000000000000)::bigint;
 insert into auth.users(id,email_confirmed_at,is_anonymous) values(customer,clock_timestamp(),false);
 insert into public.customer_profiles(user_id,onboarding_completed_at) values(customer,clock_timestamp())
 on conflict(user_id) do update set onboarding_completed_at=excluded.onboarding_completed_at;
 perform public.apiwild_gateway_account_initialize(ownerid);
 insert into apiwild_finance.provider_budgets(id,product,billing_mode,currency,key_reference,accepted,total_limit_cny_micros,daily_limit_cny_micros,rate_version,models)
 values(budget,'apiwild','live','CNY',gen_random_uuid(),true,100000,100000,'native-acceptance-only',array['claude-opus-4-6']);
 perform public.apiwild_native_key_prepare(ownerid,keyid,replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),null,null,null,budget,native_account,
 '{"claude-opus-4-6":{"input":2500000,"output":12500000,"provider":"fixture-provider"}}'::jsonb);
 perform public.apiwild_native_key_attach(ownerid,keyid,native_token);

 rejected:=false;
 begin perform public.apiwild_native_sync_claim(keyid,null);
 exception when others then if sqlerrm<>'native_sync_invalid' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: null sync claim accepted';end if;
 rejected:=false;
 begin perform public.apiwild_native_import(keyid,null,'[]');
 exception when others then if sqlerrm<>'native_sync_unavailable' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: null import fencing accepted';end if;
 rejected:=false;
 begin perform public.apiwild_native_sync_finish(keyid,null,0);
 exception when others then if sqlerrm<>'native_receipts_incomplete' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: null finish fencing accepted';end if;
 rejected:=false;
 begin perform public.apiwild_native_allocate(keyid,null,10000,5000);
 exception when others then if sqlerrm<>'native_allocation_unavailable' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: null allocation fencing accepted';end if;
 if not public.apiwild_native_sync_claim(keyid,runid) then raise exception 'FAIL: claim rejected';end if;
 rejected:=false;
 begin perform public.apiwild_native_allocate(keyid,runid,10000,5000);
 exception when others then if sqlerrm<>'native_allocation_unavailable' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: allocation before initial reconciliation accepted';end if;
 perform public.apiwild_native_sync_finish(keyid,runid,0);
 rejected:=false;
 begin perform public.apiwild_native_allocate(keyid,runid,10000,5000);
 exception when others then if sqlerrm<>'gateway_customer_limit' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: zero-funded allowance accepted';end if;
 if exists(select 1 from apiwild_finance.gateway_requests where user_id=ownerid) then raise exception 'FAIL: rejected allowance left a request';end if;

 -- Synthetic funding only, inside this rollback transaction.
 update apiwild_finance.gateway_accounts set funded_usd_micros=1000000 where user_id=ownerid;
 result:=public.apiwild_native_allocate(keyid,runid,10000,5000);
 leaseid:=(result->>'requestId')::uuid;
 if leaseid is null or not exists(select 1 from apiwild_finance.gateway_requests where id=leaseid and state='uncertain' and reserved_usd_micros=10000 and reserved_cny_micros=5000) then raise exception 'FAIL: allowance hold incorrect';end if;
 -- Incurred receipts must still settle after policy is tightened.
 perform public.apiwild_workspace_policy(ownerid,array[]::text[],0);
 receipt:=jsonb_build_object('id',1,'token',native_token,'account',native_account,'prompt',1000,'completion',200,'quota',100,'created',extract(epoch from clock_timestamp())::bigint,'model','claude-opus-4-6','provider','fixture-provider');
 result:=public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt));
 if result->>'imported'<>'1' or result->>'quota'<>'100' then raise exception 'FAIL: receipt import result %',result;end if;
 select r.cost_usd_micros,r.cost_cny_micros into cost_usd,cost_cny from apiwild_finance.native_usage_receipts n join apiwild_finance.gateway_requests r on r.id=n.request_id where n.key_id=keyid and n.log_id=1;
 if cost_usd is distinct from 5000 or cost_cny is distinct from 1360 then raise exception 'FAIL: pricing retail %, supplier %',cost_usd,cost_cny;end if;
 result:=public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt));
 if result->>'imported'<>'0' or result->>'quota'<>'100' then raise exception 'FAIL: replay imported twice';end if;
 rejected:=false;
 begin perform public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt||'{"completion":201}'::jsonb));
 exception when others then if sqlerrm<>'native_receipt_conflict' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: modified replay accepted';end if;
 rejected:=false;
 begin perform public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt||'{"id":2,"model":"unknown-model"}'::jsonb));
 exception when others then if sqlerrm<>'native_receipt_route_invalid' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: unknown model accepted';end if;
 result:=public.apiwild_native_import(keyid,runid,jsonb_build_array(receipt||'{"id":2,"prompt":1,"completion":0,"quota":1}'::jsonb));
 select r.cost_usd_micros,r.cost_cny_micros into cost_usd,cost_cny from apiwild_finance.native_usage_receipts n join apiwild_finance.gateway_requests r on r.id=n.request_id where n.key_id=keyid and n.log_id=2;
 if cost_usd is distinct from 3 or cost_cny is distinct from 14 then raise exception 'FAIL: micro rounding retail %, supplier %',cost_usd,cost_cny;end if;
 rejected:=false;
 begin perform public.apiwild_native_sync_finish(keyid,runid,100);
 exception when others then if sqlerrm<>'native_receipts_incomplete' then raise;end if;rejected:=true;end;
 if not rejected then raise exception 'FAIL: incomplete reconciliation released hold';end if;
 perform public.apiwild_native_sync_finish(keyid,runid,101);
 usage_result:=public.apiwild_gateway_usage(ownerid);
 if (usage_result->>'spentUsdMicros')::bigint is distinct from 5003 or (usage_result->>'reservedUsdMicros')::bigint is distinct from 0 or (usage_result->>'availableUsdMicros')::bigint is distinct from 994997 or (usage_result->>'completedRequests')::bigint is distinct from 2 then raise exception 'FAIL: ledger totals %',usage_result;end if;
 if (select count(*) from apiwild_finance.native_usage_receipts where key_id=keyid)<>2 then raise exception 'FAIL: receipt count';end if;
 if (select sum(cost_cny_micros) from apiwild_finance.gateway_requests where user_id=ownerid)<>1374 then raise exception 'FAIL: supplier total';end if;
 raise notice 'PASS native hourly acceptance: pricing, micro rounding, replay, conflict, unknown model, NULL fencing, zero funds, tightened policy settlement, incomplete sync, wallet and supplier totals';
end;
$fixture$;
rollback;

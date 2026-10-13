begin;
create function public.apiwild_usage_explorer(p_owner text) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare dashboard jsonb; models jsonb; activity jsonb;
begin
 dashboard:=public.apiwild_usage_dashboard(p_owner);
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into models from (
  select model,sum(requests) requests,sum(charged_usd_micros) "chargedUsdMicros",sum(input_tokens) "inputTokens",sum(output_tokens) "outputTokens",sum(cache_read_tokens) "cacheReadTokens",sum(cache_write_tokens) "cacheWriteTokens",sum(cache_read_known) "cacheReadKnown",sum(cache_write_known) "cacheWriteKnown"
  from apiwild_finance.usage_daily where owner=p_owner and day>=(clock_timestamp() at time zone 'UTC')::date-29 group by model order by sum(charged_usd_micros) desc,model limit 100
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x."createdAt" desc),'[]'::jsonb) into activity from (
  select r.id,r.created_at "createdAt",r.model,r.state,
   coalesce(apiwild_finance.usage_integer(r.usage_json->'prompt_tokens'),0) "inputTokens",
   coalesce(apiwild_finance.usage_integer(r.usage_json->'completion_tokens'),0) "outputTokens",
   coalesce(t.cache_read_tokens,apiwild_finance.usage_integer(r.usage_json->'cache_read_tokens')) "cacheReadTokens",
   coalesce(t.cache_write_tokens,apiwild_finance.usage_integer(r.usage_json->'cache_write_tokens')) "cacheWriteTokens",
   coalesce(r.cost_usd_micros,0) "chargedUsdMicros",
   (r.state='uncertain' or coalesce((r.usage_json->>'customerChargePending')::boolean,false)) pending
  from apiwild_finance.gateway_requests r left join apiwild_finance.usage_token_details t on t.request_id=r.id
  where r.user_id=p_owner and r.created_at>=((clock_timestamp() at time zone 'UTC')::date-29)::timestamp at time zone 'UTC'
   and r.state in ('succeeded','failed','uncertain') and coalesce((r.usage_json->>'nativeAllowance')::boolean,false)=false
  order by r.created_at desc,r.id limit 50
 ) x;
 return dashboard||jsonb_build_object('models',models,'activity',activity);
end;$$;
revoke all on function public.apiwild_usage_explorer(text) from public,anon,authenticated;
grant execute on function public.apiwild_usage_explorer(text) to service_role;
commit;

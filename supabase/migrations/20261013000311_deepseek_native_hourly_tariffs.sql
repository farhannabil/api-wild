-- Complete the native-key path without repricing existing persisted key snapshots.
begin;
create function apiwild_finance.native_receipt_tier_2026(p_created bigint,p_calendar text,p_from bigint,p_until bigint)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare at_utc timestamp;at_cn timestamp;day_cn text;minute_utc integer;
begin
 if p_created is null or p_from is null or p_until is null or p_until<=p_from or p_created<p_from or p_created>=p_until
  or p_calendar is distinct from 'cn-state-council-2026-7' then raise exception 'native_tier_invalid';end if;
 at_utc:=to_timestamp(p_created) at time zone 'UTC';at_cn:=to_timestamp(p_created) at time zone 'Asia/Shanghai';
 if extract(year from at_cn)<>2026 then raise exception 'native_calendar_invalid';end if;
 day_cn:=to_char(at_cn,'MM-DD');minute_utc:=extract(hour from at_utc)::integer*60+extract(minute from at_utc)::integer;
 if extract(dow from at_cn) in(0,6) or day_cn between '01-01' and '01-03' or day_cn between '02-15' and '02-23'
  or day_cn between '04-04' and '04-06' or day_cn between '05-01' and '05-05' or day_cn between '06-19' and '06-21'
  or day_cn between '09-25' and '09-27' or day_cn between '10-01' and '10-07'
  or not(minute_utc>=60 and minute_utc<240 or minute_utc>=360 and minute_utc<600) then return 'off_peak';end if;
 return 'peak';
end;$$;
create function apiwild_finance.native_request_rate_version(p_rate jsonb,p_model text,p_created bigint,p_base text)
returns text language plpgsql immutable security invoker set search_path='' as $$
begin
 if p_rate->>'processing'='off_peak' then
  if p_model is distinct from 'deepseek-v4.1-flash' then raise exception 'native_tier_invalid';end if;
  return coalesce(p_rate->>'version',p_base)||':ds26:'||apiwild_finance.native_receipt_tier_2026(p_created,p_rate->>'calendar',(p_rate->>'validFrom')::bigint,(p_rate->>'validUntil')::bigint);
 end if;
 return coalesce(p_rate->>'version',p_base);
end;$$;
revoke all on function apiwild_finance.native_receipt_tier_2026(bigint,text,bigint,bigint),apiwild_finance.native_request_rate_version(jsonb,text,bigint,text) from public,anon,authenticated,service_role;
-- Patch the current deployed importer, preserving locking, ownership, dedupe,
-- native debit verification, old snapshot data and all financial projections.
do $patch$
declare definition text;needle text;replacement text;
begin
 definition:=pg_get_functiondef('public.apiwild_native_import(uuid,uuid,jsonb)'::regprocedure);
 needle:='usd:=ceil(((f->>''prompt'')::numeric*(rate->>''input'')::numeric+(f->>''completion'')::numeric*(rate->>''output'')::numeric)/1000000);';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'native_import_definition_changed';end if;
 replacement:='usd:=apiwild_finance.native_tariff_charge(rate,f->>''model'',(f->>''prompt'')::bigint,(f->>''completion'')::bigint,(f->>''created'')::bigint);';
 definition:=replace(definition,needle,replacement);
 needle:='f->>''model'',b.rate_version,''succeeded''';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'native_import_version_definition_changed';end if;
 replacement:='f->>''model'',apiwild_finance.native_request_rate_version(rate,f->>''model'',(f->>''created'')::bigint,b.rate_version),''succeeded''';
 execute replace(definition,needle,replacement);
end;$patch$;
commit;

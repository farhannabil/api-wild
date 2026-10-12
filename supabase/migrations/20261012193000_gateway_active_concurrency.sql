-- Preserve the deployed rate-version policy and all financial hold calculations.
begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.apiwild_gateway_reserve(text,uuid,uuid,text,text,text,text,text,bigint,bigint)'::regprocedure) into definition;
 if position('count(*) filter (where state in (''reserved'',''executing'',''uncertain''))' in definition)=0
 or position(' or v_held>=2 or v_minute>=20' in definition)=0
 or position('gateway_request_limit' in definition)>0 then raise exception 'gateway_concurrency_definition_unexpected'; end if;
 definition:=replace(definition,'count(*) filter (where state in (''reserved'',''executing'',''uncertain''))','count(*) filter (where state in (''reserved'',''executing''))');
 definition:=replace(definition,' or v_held>=2 or v_minute>=20','');
 definition:=replace(definition,'then raise exception ''gateway_customer_limit''; end if;','then raise exception ''gateway_customer_limit''; end if; if v_held>=2 or v_minute>=20 then raise exception ''gateway_request_limit''; end if;');
 execute definition;
end $migration$;
commit;

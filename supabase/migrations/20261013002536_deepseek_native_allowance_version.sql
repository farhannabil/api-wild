begin;
-- A native key containing only the conditional model still needs a valid lease
-- identity. The lease is a fixed money reservation, not a token-price charge.
do $patch$
declare definition text;before_call text:='m,b.rate_version,p_usd,p_cny)';
begin
 definition:=pg_get_functiondef('public.apiwild_native_allocate(uuid,uuid,bigint,bigint)'::regprocedure);
 if position(before_call in definition)=0 then raise exception 'native_allowance_version_definition_unexpected';end if;
 execute replace(definition,before_call,'m,case when m=''deepseek-v4.1-flash'' then b.rate_version||'':ds26:peak'' else b.rate_version end,p_usd,p_cny)');
end $patch$;
commit;

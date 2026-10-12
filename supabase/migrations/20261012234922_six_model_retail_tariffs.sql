-- Owner-selected USD rates per million tokens. Immutable old requests, customer
-- balances, supplier ceilings and existing native-key snapshots stay intact.
begin;
create table if not exists apiwild_finance.model_tariffs(
 model text not null,rate_version text not null,tier text not null check(tier in('standard','peak','off_peak')),
 input_usd_micros bigint not null check(input_usd_micros between 0 and 10000000000),
 output_usd_micros bigint not null check(output_usd_micros between 0 and 10000000000),
 creator text not null,description text not null,reference_source text not null,
 schedule_calendar text,approved_at timestamptz not null default now(),
 primary key(model,rate_version,tier)
);
alter table apiwild_finance.model_tariffs enable row level security;
revoke all on apiwild_finance.model_tariffs from public,anon,authenticated;
grant select on apiwild_finance.model_tariffs to service_role;
insert into apiwild_finance.model_tariffs(model,rate_version,tier,input_usd_micros,output_usd_micros,creator,description,reference_source,schedule_calendar) values
 ('gpt-6-astra','apiwild-launch-20261005:models26','standard',5000000,25000000,'OpenAI','Reasoning, analysis and complex agent workflows.','https://developers.openai.com/api/docs/models/gpt-6-astra',null),
 ('gpt-6-sol','apiwild-launch-20261005:models26','standard',1000000,5000000,'OpenAI','Software engineering and agent workflows.','https://developers.openai.com/api/docs/models/gpt-6-sol',null),
 ('glm-5.3','apiwild-launch-20261005:models26','standard',1000000,2250000,'Z.ai','Complex software engineering and long-horizon agent tasks.','https://docs.z.ai/guides/llm/glm-5.3',null),
 ('claude-sonnet-5-5','apiwild-launch-20261005:models26','standard',1000000,5000000,'Anthropic','Coding, analysis and everyday agent workflows.','https://platform.claude.com/docs/en/about-claude/models/overview',null),
 ('gemini-3.8-flash','apiwild-launch-20261005:models26','standard',500000,1750000,'Google','Flash text route for software engineering and agents.','https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',null),
 ('deepseek-v4.1-flash','apiwild-launch-20261005:ds26:peak','peak',150000,760000,'DeepSeek','Efficient reasoning with UTC time-tier pricing.','https://api-docs.deepseek.com/quick_start/pricing/','cn-state-council-2026-7'),
 ('deepseek-v4.1-flash','apiwild-launch-20261005:ds26:off_peak','off_peak',90000,350000,'DeepSeek','Efficient reasoning with UTC time-tier pricing.','https://api-docs.deepseek.com/quick_start/pricing/','cn-state-council-2026-7')
on conflict(model,rate_version,tier) do nothing;

-- Restrict the new request-version suffix to the five reviewed model names.
-- Their old version remains readable for historical financial reconciliation.
create or replace function apiwild_finance.gateway_budget_rate_matches(p_budget text,p_request text,p_model text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select case when p_model in('deepseek-v4-flash','deepseek-v4-pro','deepseek-v4.1-flash') then
   p_budget ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,139}$'
   and p_request in(p_budget||':ds26:peak',p_budget||':ds26:off_peak')
 when p_model in('gpt-6-astra','gpt-6-sol','glm-5.3','claude-sonnet-5-5','gemini-3.8-flash') then
   p_request in(p_budget,p_budget||':models26')
 else p_budget=p_request and position(':ds26:' in p_request)=0 end;
$$;
revoke all on function apiwild_finance.gateway_budget_rate_matches(text,text,text) from public,anon,authenticated,service_role;

-- Native hourly charging uses the persisted key tariff and native receipt time,
-- never the worker's current time. Old standard-only snapshots remain valid.
create or replace function apiwild_finance.native_tariff_charge(p_rate jsonb,p_model text,p_prompt bigint,p_completion bigint,p_created bigint)
returns bigint language plpgsql immutable security invoker set search_path='' as $$
declare rate_in bigint;rate_out bigint;at_utc timestamp;at_cn timestamp;day_cn text;minute_utc integer;offpeak boolean;
begin
 if p_model is null or p_rate is null or p_prompt is null or p_completion is null or p_created is null
  or p_prompt<0 or p_prompt>10000000 or p_completion<0 or p_completion>10000000 then raise exception 'native_usage_invalid'; end if;
 rate_in:=(p_rate->>'input')::bigint;rate_out:=(p_rate->>'output')::bigint;
 if p_rate->>'processing'='off_peak' then
  if p_model is distinct from 'deepseek-v4.1-flash' or p_rate->>'calendar' is distinct from 'cn-state-council-2026-7'
   or p_rate->>'validFrom' is null or p_rate->>'validUntil' is null
   or (p_rate->>'validUntil')::bigint<=(p_rate->>'validFrom')::bigint
   or p_created<(p_rate->>'validFrom')::bigint or p_created>=(p_rate->>'validUntil')::bigint then raise exception 'native_tier_invalid'; end if;
  at_utc:=to_timestamp(p_created) at time zone 'UTC';at_cn:=to_timestamp(p_created) at time zone 'Asia/Shanghai';
  if extract(year from at_cn)<>2026 then raise exception 'native_calendar_invalid'; end if;
  day_cn:=to_char(at_cn,'MM-DD');minute_utc:=extract(hour from at_utc)::integer*60+extract(minute from at_utc)::integer;
  offpeak:=extract(dow from at_cn) in(0,6)
    or day_cn between '01-01' and '01-03' or day_cn between '02-15' and '02-23'
    or day_cn between '04-04' and '04-06' or day_cn between '05-01' and '05-05'
    or day_cn between '06-19' and '06-21' or day_cn between '09-25' and '09-27' or day_cn between '10-01' and '10-07'
    or not(minute_utc>=60 and minute_utc<240 or minute_utc>=360 and minute_utc<600);
  if not offpeak then rate_in:=(p_rate->'peak'->>'input')::bigint;rate_out:=(p_rate->'peak'->>'output')::bigint;end if;
 end if;
 if rate_in is null or rate_out is null or rate_in<0 or rate_out<0 or rate_in>10000000000 or rate_out>10000000000 then raise exception 'native_rate_invalid';end if;
 return ceil((p_prompt::numeric*rate_in+p_completion::numeric*rate_out)/1000000)::bigint;
end;
$$;
revoke all on function apiwild_finance.native_tariff_charge(jsonb,text,bigint,bigint,bigint) from public,anon,authenticated,service_role;
commit;

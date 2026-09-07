-- Service-only delivery state. Raw messages remain in Resend, never public logs.
create table public.support_deliveries (
  email_id uuid primary key,
  sender_hash text not null,
  state text not null check (state in ('processing','sent','suppressed','review')),
  reason text,
  payload jsonb,
  lease_id uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now(),
  first_attempt_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  attempts integer not null default 1,
  resend_id uuid
);
create index support_deliveries_sender_time on public.support_deliveries(sender_hash,first_attempt_at desc);
create index support_deliveries_state_time on public.support_deliveries(state,first_attempt_at);
alter table public.support_deliveries enable row level security;
revoke all on public.support_deliveries from public, anon, authenticated;
grant select, insert, update on public.support_deliveries to service_role;

create function public.claim_support_delivery(p_email_id uuid,p_sender_hash text,p_payload jsonb,p_reason text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.support_deliveries; reason text := p_reason;
begin
  -- Serialize a small support workload, including sender/day and global quotas.
  perform pg_advisory_xact_lock(194057,1);
  select * into r from public.support_deliveries where email_id=p_email_id for update;
  if found then
    if r.state <> 'processing' then return jsonb_build_object('action','done'); end if;
    -- Resend retains idempotency keys for 24h; never retry beyond a 23h boundary.
    if r.first_attempt_at < now()-interval '23 hours' then
      update public.support_deliveries set state='review',reason='retry_window_expired',updated_at=now() where email_id=p_email_id;
      return jsonb_build_object('action','done');
    end if;
    if r.lease_until > now() then return jsonb_build_object('action','busy'); end if;
    update public.support_deliveries set lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      where email_id=p_email_id returning * into r;
  else
    if reason is null and exists(select 1 from public.support_deliveries where sender_hash=p_sender_hash and state in ('processing','sent','review') and first_attempt_at>now()-interval '24 hours') then
      reason := 'sender_daily_limit';
    end if;
    if reason is null and (select count(*) from public.support_deliveries where state in ('processing','sent','review') and first_attempt_at>now()-interval '24 hours') >=75 then
      reason := 'daily_safety_limit';
    end if;
    insert into public.support_deliveries(email_id,sender_hash,state,reason,payload,lease_until)
      values(p_email_id,p_sender_hash,case when reason is null then 'processing' else 'suppressed' end,reason,case when reason is null then p_payload else null end,now()+interval '2 minutes') returning * into r;
    if reason is not null then return jsonb_build_object('action','done'); end if;
  end if;
  return jsonb_build_object('action','send','lease_id',r.lease_id,'payload',r.payload);
end;
$$;
revoke all on function public.claim_support_delivery(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.claim_support_delivery(uuid,text,jsonb,text) to service_role;

create function public.complete_support_delivery(p_email_id uuid,p_lease_id uuid,p_resend_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.support_deliveries set state='sent',resend_id=p_resend_id,updated_at=now()
    where email_id=p_email_id and lease_id=p_lease_id and state='processing';
  return found;
end;
$$;
revoke all on function public.complete_support_delivery(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_support_delivery(uuid,uuid,uuid) to service_role;

create table public.support_daily_health (
  day date primary key,
  checked_at timestamptz not null default now(),
  sent integer not null,
  suppressed integer not null,
  needs_review integer not null,
  stale_processing integer not null
);
alter table public.support_daily_health enable row level security;
revoke all on public.support_daily_health from public,anon,authenticated;
grant select on public.support_daily_health to service_role;

create function public.check_support_health() returns void language plpgsql security invoker set search_path='' as $$
begin
  update public.support_deliveries set state='review',reason='retry_window_expired',updated_at=now()
    where state='processing' and first_attempt_at<now()-interval '23 hours';
  -- Keep permanent dedup IDs; remove old delivered payloads containing recipient/subject.
  update public.support_deliveries set payload=null where state='sent' and first_attempt_at<now()-interval '30 days' and payload is not null;
  insert into public.support_daily_health(day,sent,suppressed,needs_review,stale_processing)
    select current_date,
      count(*) filter(where state='sent' and first_attempt_at>now()-interval '24 hours'),
      count(*) filter(where state='suppressed' and first_attempt_at>now()-interval '24 hours'),
      count(*) filter(where state='review'),
      count(*) filter(where state='processing' and first_attempt_at<now()-interval '30 minutes')
    from public.support_deliveries
    on conflict(day) do update set checked_at=now(),sent=excluded.sent,suppressed=excluded.suppressed,needs_review=excluded.needs_review,stale_processing=excluded.stale_processing;
end;
$$;
revoke all on function public.check_support_health() from public,anon,authenticated;

create extension if not exists pg_cron;
select cron.schedule('apiwild-support-daily-health','17 13 * * *','select public.check_support_health()');

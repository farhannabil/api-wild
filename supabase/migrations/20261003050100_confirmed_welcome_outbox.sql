-- SOURCE PREPARATION: not applied to production automatically.
-- Requires the live, separately verified multi_brand_crm foundation. Customer
-- confirmation is authoritative; raw metadata only chooses one of two brands.
-- No paid entitlement or API credit is granted, and no email is sent in SQL.
begin;

alter table public.email_outbox add column if not exists lease_id uuid;
alter table public.email_outbox add column if not exists idempotency_started_at timestamptz;
alter table public.email_outbox add column if not exists provider_message_id text;

-- Count EVERY claimed attempt on its delivery date, including cross-midnight
-- retries. The original event's first attempt date is not a daily quota ledger.
create table if not exists public.email_delivery_budget (
  delivery_date date primary key,
  attempts integer not null default 0 check (attempts between 0 and 10)
);
alter table public.email_delivery_budget enable row level security;
revoke all on public.email_delivery_budget from public, anon, authenticated, service_role;

create or replace function public.queue_confirmed_welcome()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_brand text;
  v_event text;
begin
  if new.email_confirmed_at is null or new.email is null or new.is_anonymous is true then return new; end if;
  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then return new; end if;
  v_brand := case when new.raw_user_meta_data->>'signup_product' = 'aaro' then 'aaro' else 'apiwild' end;
  v_event := 'confirmed-welcome/' || v_brand || '/' || new.id::text;
  -- Missing brand registration must not break the existing customer signup.
  if not exists (select 1 from public.brand_registry b where b.slug = v_brand and b.active) then return new; end if;
  insert into public.customer_brand_memberships (customer_id, brand_slug)
    values (new.id, v_brand) on conflict (customer_id, brand_slug) do nothing;
  insert into public.crm_events (event_key, customer_id, brand_slug, event_type)
    values (v_event, new.id, v_brand, 'email_confirmed') on conflict (event_key) do nothing;
  insert into public.email_outbox (event_key, customer_id, brand_slug, recipient, template)
    values (v_event, new.id, v_brand, new.email, 'confirmed-welcome-v1') on conflict (event_key) do nothing;
  return new;
end;
$$;
revoke all on function public.queue_confirmed_welcome() from public, anon, authenticated;

-- The existing profile trigger is not replaced. This new trigger only queues
-- the first confirmed welcome, with a unique event key preventing duplicates.
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_customer_email_confirmed_welcome') then
    create trigger on_customer_email_confirmed_welcome after insert or update of email_confirmed_at
      on auth.users for each row execute function public.queue_confirmed_welcome();
  end if;
end;
$$;

create or replace function public.claim_confirmed_welcome(p_limit integer default 1)
returns table(id uuid, lease_id uuid, brand_slug text, recipient text, template text)
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  v_remaining integer;
  v_claimed integer;
  v_day date := (now() at time zone 'UTC')::date;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5 then raise exception 'invalid_email_batch'; end if;
  -- Serialize the UTC daily allocation and increment once per actual claim.
  insert into public.email_delivery_budget(delivery_date) values(v_day)
    on conflict(delivery_date) do nothing;
  select 10-b.attempts into v_remaining from public.email_delivery_budget b
    where b.delivery_date=v_day for update;
  if v_remaining = 0 then return; end if;
  -- A processing/ambiguous row is NEVER automatically reclaimed. The provider
  -- might have sent even if its response or our final DB write was lost.
  update public.email_outbox o set status='failed', last_error='retry_window_expired', updated_at=now()
    where o.template='confirmed-welcome-v1' and o.status='pending'
      and o.idempotency_started_at is not null and o.idempotency_started_at < now()-interval '23 hours';
  return query
  with candidates as (
    select o.id from public.email_outbox o join auth.users u on u.id=o.customer_id
    where o.template='confirmed-welcome-v1' and o.brand_slug in ('apiwild','aaro')
      and o.status='pending' and o.scheduled_at <= now() and o.attempts < 3
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
      and u.email=o.recipient
      and exists (select 1 from public.customer_brand_memberships m
        where m.customer_id=o.customer_id and m.brand_slug=o.brand_slug and m.status='active')
      and exists (select 1 from public.brand_registry b where b.slug=o.brand_slug and b.active)
    order by o.scheduled_at,o.id for update of o skip locked limit least(p_limit,v_remaining)
  )
  update public.email_outbox o set status='processing', attempts=o.attempts+1,
    lease_id=gen_random_uuid(), idempotency_started_at=coalesce(o.idempotency_started_at,now()), updated_at=now()
  from candidates c where o.id=c.id
  returning o.id,o.lease_id,o.brand_slug,o.recipient,o.template;
  get diagnostics v_claimed = row_count;
  update public.email_delivery_budget b set attempts=b.attempts+v_claimed where b.delivery_date=v_day;
end;
$$;

create or replace function public.finish_confirmed_welcome(p_id uuid, p_lease_id uuid, p_outcome text, p_provider_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome is null or p_outcome not in ('sent','retry','failed','ambiguous') then raise exception 'invalid_email_outcome'; end if;
  if p_outcome='sent' and (p_provider_id is null or p_provider_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then raise exception 'invalid_email_receipt'; end if;
  update public.email_outbox o set
    status = case when p_outcome='sent' then 'sent'
      when p_outcome='ambiguous' then 'processing'
      when p_outcome='retry' and o.attempts < 3 and o.idempotency_started_at > now()-interval '23 hours' then 'pending'
      else 'failed' end,
    scheduled_at = case when p_outcome='retry' then now() + interval '1 minute' * power(2,o.attempts) else o.scheduled_at end,
    provider_message_id = case when p_outcome='sent' then p_provider_id else o.provider_message_id end,
    sent_at = case when p_outcome='sent' then now() else o.sent_at end,
    last_error = case when p_outcome='sent' then null else p_outcome end,
    updated_at=now()
  where o.id=p_id and o.lease_id=p_lease_id and o.status='processing' and o.template='confirmed-welcome-v1';
  if not found then raise exception 'email_lease_mismatch'; end if;
end;
$$;
revoke all on function public.claim_confirmed_welcome(integer) from public, anon, authenticated;
revoke all on function public.finish_confirmed_welcome(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.claim_confirmed_welcome(integer) to service_role;
grant execute on function public.finish_confirmed_welcome(uuid,uuid,text,text) to service_role;
commit;

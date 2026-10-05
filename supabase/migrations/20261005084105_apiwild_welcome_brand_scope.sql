-- Add an API WILD-only claim. Preserve the shared worker's existing contract.
-- No email is sent, enqueued or replayed by installing this migration.
begin;
create function apiwild_finance.claim_apiwild_confirmed_welcome(p_limit integer default 1)
returns table(id uuid,lease_id uuid,brand_slug text,recipient text,template text)
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare v_remaining integer;v_claimed integer;v_day date:=(now() at time zone 'UTC')::date;
begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null then raise exception 'welcome_server_only';end if;
  if p_limit is null or p_limit<1 or p_limit>5 then raise exception 'invalid_email_batch';end if;
  insert into public.email_delivery_budget(delivery_date) values(v_day) on conflict(delivery_date) do nothing;
  select 10-b.attempts into v_remaining from public.email_delivery_budget b where b.delivery_date=v_day for update;
  if v_remaining=0 then return;end if;
  -- Scope cleanup too: this deployment never updates another brand's rows.
  update public.email_outbox o set status='failed',last_error='retry_window_expired',updated_at=now()
    where o.brand_slug='apiwild' and o.template='confirmed-welcome-v1' and o.status='pending'
      and o.idempotency_started_at is not null and o.idempotency_started_at<now()-interval '23 hours';
  return query
  with candidates as (
    select o.id from public.email_outbox o join auth.users u on u.id=o.customer_id
    where o.template='confirmed-welcome-v1' and o.brand_slug='apiwild'
      and o.status='pending' and o.scheduled_at<=now() and o.attempts<3
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and u.email=o.recipient
      and exists(select 1 from public.customer_brand_memberships m where m.customer_id=o.customer_id and m.brand_slug='apiwild' and m.status='active')
      and exists(select 1 from public.brand_registry b where b.slug='apiwild' and b.active)
    order by o.scheduled_at,o.id for update of o skip locked limit least(p_limit,v_remaining)
  )
  update public.email_outbox o set status='processing',attempts=o.attempts+1,lease_id=gen_random_uuid(),
    idempotency_started_at=coalesce(o.idempotency_started_at,now()),updated_at=now()
  from candidates c where o.id=c.id returning o.id,o.lease_id,o.brand_slug,o.recipient,o.template;
  get diagnostics v_claimed=row_count;
  update public.email_delivery_budget b set attempts=b.attempts+v_claimed where b.delivery_date=v_day;
end;$$;
-- Keep the Data API entrypoint unprivileged; only the private helper elevates.
create function public.claim_apiwild_confirmed_welcome(p_limit integer default 1)
returns table(id uuid,lease_id uuid,brand_slug text,recipient text,template text)
language sql security invoker set search_path='' as $$
  select * from apiwild_finance.claim_apiwild_confirmed_welcome(p_limit);
$$;
revoke all on function apiwild_finance.claim_apiwild_confirmed_welcome(integer) from public,anon,authenticated;
grant execute on function apiwild_finance.claim_apiwild_confirmed_welcome(integer) to service_role;
revoke all on function public.claim_apiwild_confirmed_welcome(integer) from public,anon,authenticated;
grant execute on function public.claim_apiwild_confirmed_welcome(integer) to service_role;
commit;

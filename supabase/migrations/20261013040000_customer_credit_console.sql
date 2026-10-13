begin;
-- Campaigns are private and inactive until an operator supplies approved terms.
create table apiwild_finance.credit_codes (
 code text primary key check(code ~ '^[A-Z0-9_-]{4,48}$'),
 amount_cents bigint not null check(amount_cents between 1 and 100000),
 max_redemptions integer not null check(max_redemptions between 1 and 100000),
 redeemed integer not null default 0 check(redeemed>=0 and redeemed<=max_redemptions),
 starts_at timestamptz not null, ends_at timestamptz not null check(ends_at>starts_at),
 enabled boolean not null default false
);
create table apiwild_finance.credit_redemptions (
 id uuid primary key default gen_random_uuid(), code text not null references apiwild_finance.credit_codes(code),
 owner text not null references apiwild_finance.gateway_accounts(user_id), amount_cents bigint not null,
 created_at timestamptz not null default clock_timestamp(), unique(code,owner)
);
create table apiwild_finance.credit_email_queue (
 id uuid primary key default gen_random_uuid(), event_key text unique not null,
 owner text not null references apiwild_finance.gateway_accounts(user_id), recipient text not null,
 amount_cents bigint not null check(amount_cents>0), source text not null check(source in ('card','promo')),
 created_at timestamptz not null default clock_timestamp(), status text not null default 'pending' check(status in ('pending','processing','sent','failed')),
 attempts integer not null default 0, first_attempt_at timestamptz, next_attempt_at timestamptz not null default clock_timestamp(),
 lease_id uuid, lease_until timestamptz, provider_id uuid
);
create table apiwild_finance.customer_key_names (
 key_id uuid primary key references apiwild_finance.gateway_keys(id),
 name text not null check(length(name) between 1 and 64 and name !~ '[[:cntrl:]]')
);
alter table apiwild_finance.credit_codes enable row level security;
alter table apiwild_finance.credit_redemptions enable row level security;
alter table apiwild_finance.credit_email_queue enable row level security;
alter table apiwild_finance.customer_key_names enable row level security;
revoke all on apiwild_finance.credit_codes,apiwild_finance.credit_redemptions,apiwild_finance.credit_email_queue,apiwild_finance.customer_key_names from public,anon,authenticated,service_role;

create function apiwild_finance.queue_credit_email(p_event text,p_owner text,p_amount bigint,p_source text) returns void
language sql set search_path='' as $$
 insert into apiwild_finance.credit_email_queue(event_key,owner,recipient,amount_cents,source)
 select p_event,p_owner,u.email,p_amount,p_source from apiwild_finance.gateway_accounts a join auth.users u on u.id=a.customer_id
 where a.user_id=p_owner and a.billing_mode='live' and u.email_confirmed_at is not null
 on conflict(event_key) do nothing;
$$;
create function apiwild_finance.card_credit_email() returns trigger language plpgsql set search_path='' as $$
begin
 if new.amount_cents>0 and new.source_id like 'checkout:%' then
  perform apiwild_finance.queue_credit_email('card:'||new.account_id||':'||new.source_id,new.user_id,new.amount_cents,'card');
 end if;
 return new;
end;$$;
create trigger card_credit_email after insert on apiwild_finance.stripe_credit_entries for each row execute function apiwild_finance.card_credit_email();

create function public.apiwild_redeem_credit_code(p_owner text,p_code text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
declare c apiwild_finance.credit_codes; r apiwild_finance.credit_redemptions; normalized text:=upper(btrim(p_code));
begin
 perform apiwild_finance.assert_customer(p_owner);
 if p_owner not like 'live:supabase:%' or normalized is null or normalized !~ '^[A-Z0-9_-]{4,48}$' then return jsonb_build_object('redeemed',false,'reason','unavailable');end if;
 -- Lock owner first, consistently with financial mutations; campaign lock enforces its global cap.
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 perform apiwild_finance.assert_customer(p_owner);
 select * into r from apiwild_finance.credit_redemptions where owner=p_owner and code=normalized;
 if found then return jsonb_build_object('redeemed',true,'replayed',true,'amountCents',r.amount_cents);end if;
 select * into c from apiwild_finance.credit_codes where code=normalized for update;
 if not found or not c.enabled or c.starts_at>clock_timestamp() or c.ends_at<=clock_timestamp() or c.redeemed>=c.max_redemptions then return jsonb_build_object('redeemed',false,'reason','unavailable');end if;
 insert into apiwild_finance.credit_redemptions(code,owner,amount_cents) values(c.code,p_owner,c.amount_cents) returning * into r;
 update apiwild_finance.credit_codes set redeemed=redeemed+1,enabled=(redeemed+1<max_redemptions) where code=c.code;
 update apiwild_finance.gateway_accounts set funded_usd_micros=funded_usd_micros+c.amount_cents*10000,updated_at=clock_timestamp() where user_id=p_owner;
 perform apiwild_finance.queue_credit_email('promo:'||r.id,p_owner,r.amount_cents,'promo');
 return jsonb_build_object('redeemed',true,'replayed',false,'amountCents',r.amount_cents);
end;$$;

create function public.apiwild_credit_history(p_owner text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform apiwild_finance.assert_customer(p_owner);
 return coalesce((select jsonb_agg(to_jsonb(r)) from (select id,amount_cents,created_at from apiwild_finance.credit_redemptions where owner=p_owner order by created_at desc limit 100) r),'[]'::jsonb);
end;$$;
create function public.apiwild_customer_key_names(p_owner text,p_id uuid default null,p_name text default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='10s' as $$
begin
 perform apiwild_finance.assert_customer(p_owner);
 if p_id is not null then
  if p_name is null or length(btrim(p_name)) not between 1 and 64 or p_name ~ '[[:cntrl:]]' then raise exception 'invalid_key_name';end if;
  perform 1 from apiwild_finance.gateway_keys where id=p_id and user_id=p_owner for update;
  if not found then raise exception 'key_unavailable';end if;
  insert into apiwild_finance.customer_key_names values(p_id,btrim(p_name)) on conflict(key_id) do update set name=excluded.name;
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',n.key_id,'name',n.name)) from apiwild_finance.customer_key_names n join apiwild_finance.gateway_keys k on k.id=n.key_id where k.user_id=p_owner),'[]'::jsonb);
end;$$;

create function public.apiwild_claim_credit_email() returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare j apiwild_finance.credit_email_queue;
begin
 -- Retrying after the provider's 24-hour idempotency window could duplicate a message.
 update apiwild_finance.credit_email_queue set status='failed' where status in ('pending','processing') and (lease_until is null or lease_until<clock_timestamp()) and (attempts>=5 or first_attempt_at<clock_timestamp()-interval '23 hours');
 select * into j from apiwild_finance.credit_email_queue where status in ('pending','processing') and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp()) order by created_at for update skip locked limit 1;
 if not found then return null;end if;
 update apiwild_finance.credit_email_queue set status='processing',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'leaseId',j.lease_id,'recipient',j.recipient,'amountCents',j.amount_cents,'source',j.source);
end;$$;
create function public.apiwild_finish_credit_email(p_id uuid,p_lease uuid,p_outcome text,p_provider uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_outcome not in ('sent','retry','failed') or p_outcome is null or (p_outcome='sent')<>(p_provider is not null) then raise exception 'invalid_email_outcome';end if;
 update apiwild_finance.credit_email_queue set status=case when p_outcome='retry' then 'pending' else p_outcome end,provider_id=p_provider,lease_until=null,lease_id=null,next_attempt_at=clock_timestamp()+interval '5 minutes' where id=p_id and lease_id=p_lease and status='processing';
 return jsonb_build_object('finished',found);
end;$$;
revoke all on function apiwild_finance.queue_credit_email(text,text,bigint,text),apiwild_finance.card_credit_email(),public.apiwild_redeem_credit_code(text,text),public.apiwild_credit_history(text),public.apiwild_customer_key_names(text,uuid,text),public.apiwild_claim_credit_email(),public.apiwild_finish_credit_email(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.apiwild_redeem_credit_code(text,text),public.apiwild_credit_history(text),public.apiwild_customer_key_names(text,uuid,text),public.apiwild_claim_credit_email(),public.apiwild_finish_credit_email(uuid,uuid,text,uuid) to service_role;
commit;

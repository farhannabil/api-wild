-- Additive AARO subscription fulfillment. No legacy D1 or API WILD balances are imported.
-- All records remain unaccepted until a signed canonical processor fact is applied.
begin;
alter table aaro_finance.accounts add column funding_accepted boolean not null default false;
create table aaro_finance.stripe_customers (
 owner text primary key references aaro_finance.accounts(owner),
 customer_id text not null unique check(customer_id ~ '^cus_[A-Za-z0-9]+$')
);
create table aaro_finance.checkout_bindings (
 id uuid primary key, owner text not null references aaro_finance.accounts(owner),
 active_owner text unique references aaro_finance.accounts(owner),
 customer_id text not null references aaro_finance.stripe_customers(customer_id),
 plan_reference text not null, plan jsonb not null,
 subscription_id text unique, session_id text unique,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '1 hour',
 check(active_owner is null or active_owner=owner)
);
create table aaro_finance.region_evidence (
 owner text primary key references aaro_finance.accounts(owner),
 country text not null check(country='BD'), expires_at timestamptz not null,
 receipt_sha256 text not null check(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 accepted boolean not null default false
);
create table aaro_finance.stripe_projection_events (
 id text primary key check(id ~ '^evt_[A-Za-z0-9]+$'),
 digest text not null check(digest ~ '^[a-f0-9]{64}$'), event_type text not null,
 operation text not null check(operation in ('subscription','invoice','hold','checkout')),
 checkout_id uuid not null references aaro_finance.checkout_bindings(id),
 created_at timestamptz not null default clock_timestamp()
);
create table aaro_finance.payment_holds (
 owner text not null references aaro_finance.accounts(owner),
 invoice_id text not null check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
 source_reference text not null, receipt_sha256 text not null check(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 primary key(owner,source_reference)
);
alter table aaro_finance.stripe_customers enable row level security;
alter table aaro_finance.checkout_bindings enable row level security;
alter table aaro_finance.region_evidence enable row level security;
alter table aaro_finance.stripe_projection_events enable row level security;
alter table aaro_finance.payment_holds enable row level security;
create index aaro_bindings_owner_idx on aaro_finance.checkout_bindings(owner);
create index aaro_bindings_customer_idx on aaro_finance.checkout_bindings(customer_id);
create index aaro_events_checkout_idx on aaro_finance.stripe_projection_events(checkout_id);
revoke all on all tables in schema aaro_finance from public,anon,authenticated,service_role;

create function aaro_finance.plan_v1(p_id text) returns jsonb
language sql immutable set search_path='' as $$
 select case p_id
 when 'bd-free' then '{"id":"bd-free","region":"BD","currency":"bdt","amount":0,"credits":25000,"priceId":"price_1UJxS7194XZKj6cFdPbGqUrt","productId":"prod_aaro_bd_free_20260926"}'::jsonb
 when 'bd-starter' then '{"id":"bd-starter","region":"BD","currency":"bdt","amount":45600,"credits":150000,"priceId":"price_1UJxSA194XZKj6cFplklBHn5","productId":"prod_aaro_bd_starter_20260926"}'::jsonb
 when 'bd-plus' then '{"id":"bd-plus","region":"BD","currency":"bdt","amount":78900,"credits":399000,"priceId":"price_1UJxSC194XZKj6cFBtsvQ1YU","productId":"prod_aaro_bd_plus_20260926"}'::jsonb
 when 'bd-max' then '{"id":"bd-max","region":"BD","currency":"bdt","amount":123400,"credits":1200000,"priceId":"price_1UJxSJ194XZKj6cFHkj7glPr","productId":"prod_aaro_bd_max_20260926"}'::jsonb
 when 'global-starter' then '{"id":"global-starter","region":"GLOBAL","currency":"usd","amount":1500,"credits":300000,"priceId":"price_1UJxSM194XZKj6cFHXqdKVq1","productId":"prod_aaro_global_starter_20260926"}'::jsonb
 when 'global-plus' then '{"id":"global-plus","region":"GLOBAL","currency":"usd","amount":7900,"credits":750000,"priceId":"price_1UJxSO194XZKj6cFPjgx3bQz","productId":"prod_aaro_global_plus_20260926"}'::jsonb
 when 'global-max' then '{"id":"global-max","region":"GLOBAL","currency":"usd","amount":13900,"credits":3000000,"priceId":"price_1UJxSR194XZKj6cFf3xHVOq5","productId":"prod_aaro_global_max_20260926"}'::jsonb
 end;
$$;
create function aaro_finance.confirmed_owner_v1(p_owner text) returns void
language plpgsql set search_path='' as $$
begin
 if p_owner is null or p_owner !~ '^(live|test):supabase:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 or not exists(select 1 from auth.users where id=split_part(p_owner,':',3)::uuid and email_confirmed_at is not null and is_anonymous=false)
 then raise exception 'aaro_unverified_owner'; end if;
end;
$$;
create function public.aaro_billing_customer_v1(p_owner text,p_customer text default null) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare existing text;
begin
 perform aaro_finance.confirmed_owner_v1(p_owner);
 insert into aaro_finance.accounts(owner,customer_id,billing_mode)
 values(p_owner,split_part(p_owner,':',3)::uuid,split_part(p_owner,':',1)) on conflict(owner) do nothing;
 perform 1 from aaro_finance.accounts where owner=p_owner for update;
 select customer_id into existing from aaro_finance.stripe_customers where owner=p_owner;
 if p_customer is not null then
  if p_customer !~ '^cus_[A-Za-z0-9]+$' or (existing is not null and existing<>p_customer) then raise exception 'aaro_customer_binding_conflict'; end if;
  insert into aaro_finance.stripe_customers(owner,customer_id) values(p_owner,p_customer) on conflict(owner) do nothing;
  existing:=p_customer;
 end if;
 return jsonb_build_object('owner',p_owner,'customerId',existing);
end; $$;
create function public.aaro_checkout_prepare_v1(p_owner text,p_id uuid,p_plan_reference text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare candidate aaro_finance.checkout_bindings; plan jsonb; customer text;
begin
 perform aaro_finance.confirmed_owner_v1(p_owner);
 perform 1 from aaro_finance.accounts where owner=p_owner for update;
 if not found then raise exception 'aaro_customer_unregistered'; end if;
 plan:=aaro_finance.plan_v1(p_plan_reference);
 if plan is null then raise exception 'aaro_invalid_plan'; end if;
 if plan->>'region'='BD' and not exists(select 1 from aaro_finance.region_evidence where owner=p_owner and accepted and expires_at>clock_timestamp())
 then raise exception 'aaro_region_unaccepted'; end if;
 select customer_id into customer from aaro_finance.stripe_customers where owner=p_owner;
 if customer is null then raise exception 'aaro_customer_unregistered'; end if;
 select * into candidate from aaro_finance.checkout_bindings where active_owner=p_owner;
 if found then
  if candidate.plan_reference<>p_plan_reference then raise exception 'aaro_checkout_conflict'; end if;
 else
  insert into aaro_finance.checkout_bindings(id,owner,active_owner,customer_id,plan_reference,plan)
  values(p_id,p_owner,p_owner,customer,p_plan_reference,plan) returning * into candidate;
 end if;
 return to_jsonb(candidate);
end; $$;
create function public.aaro_checkout_record_v1(p_owner text,p_id uuid,p_session text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare candidate aaro_finance.checkout_bindings;
begin
 perform aaro_finance.confirmed_owner_v1(p_owner);
 perform 1 from aaro_finance.accounts where owner=p_owner for update;
 select * into candidate from aaro_finance.checkout_bindings where id=p_id and owner=p_owner for update;
 if not found or p_session is null or p_session !~ ('^cs_'||split_part(p_owner,':',1)||'_[A-Za-z0-9]+$')
 or (candidate.session_id is not null and candidate.session_id<>p_session) then raise exception 'aaro_checkout_conflict'; end if;
 update aaro_finance.checkout_bindings set session_id=p_session where id=p_id returning * into candidate;
 return to_jsonb(candidate);
end; $$;
create function public.aaro_stripe_binding_read_v1(p_subscription text default null,p_checkout uuid default null) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare candidate aaro_finance.checkout_bindings;
begin
 if p_subscription is not null then select * into candidate from aaro_finance.checkout_bindings where subscription_id=p_subscription; end if;
 if candidate.id is null and p_checkout is not null then select * into candidate from aaro_finance.checkout_bindings where id=p_checkout; end if;
 if candidate.id is null then return jsonb_build_object('binding',null); end if;
 return jsonb_build_object('binding',to_jsonb(candidate),'bangladeshEligible',
 candidate.plan->>'region'<>'BD' or exists(select 1 from aaro_finance.region_evidence where owner=candidate.owner and accepted and expires_at>clock_timestamp()));
end; $$;

create function public.aaro_stripe_project_v1(p_account_id text,p_billing_mode text,p_event_id text,p_event_type text,p_digest text,p_operation text,p_fact jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare b aaro_finance.checkout_bindings; existing aaro_finance.stripe_projection_events;
 sub aaro_finance.subscriptions; period aaro_finance.credit_periods; status text; invoice text;
begin
 if p_billing_mode is null or p_billing_mode not in ('live','test') or p_account_id is distinct from (case p_billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end)
 or p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$' or p_event_type is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_operation is null or p_operation not in ('subscription','invoice','hold','checkout')
 or jsonb_typeof(p_fact) is distinct from 'object' or p_fact->>'product' is distinct from 'aaro'
 or not coalesce(p_fact ?& array['product','checkoutId','customerId'],false)
 or not coalesce(p_fact->>'checkoutId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)
 then raise exception 'aaro_invalid_projection'; end if;
 select * into b from aaro_finance.checkout_bindings where id=(p_fact->>'checkoutId')::uuid;
 if not found or b.owner not like p_billing_mode||':supabase:%' or b.customer_id is distinct from p_fact->>'customerId'
 then raise exception 'aaro_projection_binding_conflict'; end if;
 -- Finance reservation uses owner then period after its product/key locks.
 perform 1 from aaro_finance.accounts where owner=b.owner for update;
 select * into b from aaro_finance.checkout_bindings where id=b.id for update;
 select * into existing from aaro_finance.stripe_projection_events where id=p_event_id;
 if found then
  if existing.digest<>p_digest or existing.checkout_id<>b.id or existing.operation<>p_operation or existing.event_type<>p_event_type then raise exception 'aaro_event_conflict'; end if;
  return jsonb_build_object('applied',true,'replayed',true,'eventId',p_event_id);
 end if;
 if p_operation='checkout' then
  if p_event_type not in ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed')
   or not coalesce(p_fact->>'sessionId' ~ ('^cs_'||p_billing_mode||'_[A-Za-z0-9]+$'),false)
   or (b.session_id is not null and b.session_id<>p_fact->>'sessionId') then raise exception 'aaro_invalid_projection'; end if;
  update aaro_finance.checkout_bindings set session_id=p_fact->>'sessionId',
   active_owner=case when p_fact->>'status'='expired' and subscription_id is null then null else active_owner end where id=b.id;
 elsif p_operation='hold' then
  if p_event_type not in ('charge.refunded','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated','radar.early_fraud_warning.created')
   or not coalesce(p_fact->>'invoiceId' ~ '^in_[A-Za-z0-9]+$',false) or not coalesce(p_fact->>'sourceReference' ~ '^(ch|re|dp|issfr)_[A-Za-z0-9]+$',false)
   or not coalesce(p_fact->>'subscriptionId' ~ '^sub_[A-Za-z0-9]+$',false) or (b.subscription_id is not null and b.subscription_id<>p_fact->>'subscriptionId') then raise exception 'aaro_invalid_projection'; end if;
  insert into aaro_finance.payment_holds(owner,invoice_id,source_reference,receipt_sha256)
   values(b.owner,p_fact->>'invoiceId',p_fact->>'sourceReference',p_digest) on conflict do nothing;
  update aaro_finance.accounts set frozen=true where owner=b.owner;
  update aaro_finance.credit_periods set frozen=true where owner=b.owner and invoice_id=p_fact->>'invoiceId';
 else
  if not coalesce(p_fact ?& array['subscriptionId','planReference','priceId','currency','amount','subscriptionStatus'],false)
   or not coalesce(p_fact->>'subscriptionId' ~ '^sub_[A-Za-z0-9]+$',false)
   or (b.subscription_id is not null and b.subscription_id<>p_fact->>'subscriptionId')
   or p_fact->>'planReference' is distinct from b.plan_reference or p_fact->>'priceId' is distinct from b.plan->>'priceId' or p_fact->>'currency' is distinct from b.plan->>'currency'
   or (p_fact->>'amount')::bigint<>(b.plan->>'amount')::bigint then raise exception 'aaro_invalid_projection'; end if;
  if b.plan->>'region'='BD' and not exists(select 1 from aaro_finance.region_evidence where owner=b.owner and accepted and expires_at>clock_timestamp())
   then raise exception 'aaro_region_unaccepted'; end if;
  status:=p_fact->>'subscriptionStatus';
  if status is null or status not in ('active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused','trialing') then raise exception 'aaro_invalid_projection'; end if;
  if p_operation='subscription' and p_event_type not in ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed') then raise exception 'aaro_invalid_projection'; end if;
  if p_operation='invoice' and p_event_type not in ('invoice.paid','invoice.payment_failed','invoice.payment_action_required','invoice.voided','invoice.marked_uncollectible') then raise exception 'aaro_invalid_projection'; end if;
  select * into sub from aaro_finance.subscriptions where id=p_fact->>'subscriptionId' for update;
  if found and (sub.owner<>b.owner or sub.plan_reference<>b.plan_reference or sub.billing_mode<>p_billing_mode) then raise exception 'aaro_projection_binding_conflict'; end if;
  if sub.status in ('cancelled','held') then status:='canceled'; end if; -- terminal states never resurrect
  insert into aaro_finance.subscriptions(id,owner,account_id,billing_mode,plan_reference,status,projection_receipt_sha256)
  values(p_fact->>'subscriptionId',b.owner,p_account_id,p_billing_mode,b.plan_reference,case status when 'active' then 'active' when 'past_due' then 'past_due' when 'canceled' then 'cancelled' when 'incomplete_expired' then 'cancelled' else 'unaccepted' end,p_digest)
  on conflict(id) do update set status=excluded.status,projection_receipt_sha256=p_digest;
  update aaro_finance.checkout_bindings set subscription_id=p_fact->>'subscriptionId',
   active_owner=case when status in ('canceled','incomplete_expired') then null else active_owner end where id=b.id;
  if p_operation='invoice' then
   invoice:=p_fact->>'invoiceId';
   if invoice is null or invoice !~ '^in_[A-Za-z0-9]+$' then raise exception 'aaro_invalid_projection'; end if;
   if p_fact->>'paid'='true' and status='active' then
    if p_fact->'paid' is distinct from 'true'::jsonb or p_event_type<>'invoice.paid'
     or not coalesce(p_fact->>'periodStart' ~ '^[0-9]{1,12}$' and p_fact->>'periodEnd' ~ '^[0-9]{1,12}$',false)
     or p_fact->'processorVerified' is distinct from 'true'::jsonb or (p_fact->>'periodEnd')::bigint<=(p_fact->>'periodStart')::bigint
     or (p_fact->>'periodEnd')::bigint-(p_fact->>'periodStart')::bigint>32*86400 then raise exception 'aaro_invalid_projection'; end if;
    select * into period from aaro_finance.credit_periods where invoice_id=invoice for update;
    if found and (period.owner<>b.owner or period.subscription_id<>p_fact->>'subscriptionId'
     or period.credits<>(b.plan->>'credits')::bigint or period.period_start<>to_timestamp((p_fact->>'periodStart')::bigint)
     or period.period_end<>to_timestamp((p_fact->>'periodEnd')::bigint)) then raise exception 'aaro_invoice_conflict'; end if;
    if exists(select 1 from aaro_finance.credit_periods where owner=b.owner and invoice_id<>invoice
     and period_start<to_timestamp((p_fact->>'periodEnd')::bigint) and period_end>to_timestamp((p_fact->>'periodStart')::bigint))
     then raise exception 'aaro_invoice_period_overlap'; end if;
    insert into aaro_finance.credit_periods(invoice_id,subscription_id,owner,credits,period_start,period_end,paid,frozen,projection_receipt_sha256)
    values(invoice,p_fact->>'subscriptionId',b.owner,(b.plan->>'credits')::bigint,to_timestamp((p_fact->>'periodStart')::bigint),to_timestamp((p_fact->>'periodEnd')::bigint),true,
     exists(select 1 from aaro_finance.payment_holds where owner=b.owner),p_digest)
    on conflict(invoice_id) do update set paid=true,
     frozen=aaro_finance.credit_periods.frozen or exists(select 1 from aaro_finance.payment_holds where owner=b.owner),
     projection_receipt_sha256=p_digest;
    -- Only the first verified funding can open a new account. Existing manual/
    -- refund freezes remain sticky; renewal cannot erase spent/reserved units.
    update aaro_finance.accounts set frozen=case when not funding_accepted and not exists(select 1 from aaro_finance.payment_holds where owner=b.owner) then false else frozen end,
     funding_accepted=true where owner=b.owner;
   else
    update aaro_finance.credit_periods set frozen=true where invoice_id=invoice and owner=b.owner;
   end if;
  end if;
 end if;
 insert into aaro_finance.stripe_projection_events(id,digest,event_type,operation,checkout_id)
 values(p_event_id,p_digest,p_event_type,p_operation,b.id);
 return jsonb_build_object('applied',true,'replayed',false,'eventId',p_event_id);
end; $$;
create function public.aaro_billing_read_v1(p_owner text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 perform aaro_finance.confirmed_owner_v1(p_owner);
 return jsonb_build_object('owner',p_owner,'frozen',coalesce((select frozen from aaro_finance.accounts where owner=p_owner),true),
 'subscriptions',coalesce((select jsonb_agg(jsonb_build_object('plan',plan_reference,'status',status,'subscriptionId',id)) from aaro_finance.subscriptions where owner=p_owner),'[]'::jsonb),
 'creditPeriods',coalesce((select jsonb_agg(jsonb_build_object('invoiceId',invoice_id,'credits',credits,'spentCredits',spent_credits,'reservedCredits',reserved_credits,'remainingCredits',credits-spent_credits-reserved_credits,'periodStart',period_start,'periodEnd',period_end,'paid',paid,'frozen',frozen)) from aaro_finance.credit_periods where owner=p_owner),'[]'::jsonb));
end; $$;
revoke all on all functions in schema aaro_finance from public,anon,authenticated,service_role;
revoke all on function public.aaro_billing_customer_v1(text,text),public.aaro_checkout_prepare_v1(text,uuid,text),
 public.aaro_checkout_record_v1(text,uuid,text),public.aaro_stripe_binding_read_v1(text,uuid),
 public.aaro_stripe_project_v1(text,text,text,text,text,text,jsonb),public.aaro_billing_read_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.aaro_billing_customer_v1(text,text),public.aaro_checkout_prepare_v1(text,uuid,text),
 public.aaro_checkout_record_v1(text,uuid,text),public.aaro_stripe_binding_read_v1(text,uuid),
 public.aaro_stripe_project_v1(text,text,text,text,text,text,jsonb),public.aaro_billing_read_v1(text) to service_role;
commit;

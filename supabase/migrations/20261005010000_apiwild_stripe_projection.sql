-- API WILD financial projection migration. No balances, orders or keys seeded.
-- The server must first verify Stripe's signed raw envelope and re-fetch the
-- canonical objects using the exact account. This service-only RPC is NOT a
-- signature verifier. Trusted order registration/import is a separate owner lane.
-- API WILD USD one-time orders only; never project AARO subscription/product units.
begin;

create table if not exists apiwild_finance.stripe_orders (
  id uuid primary key,
  product text not null default 'apiwild' check (product='apiwild'),
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  billing_mode text not null check (billing_mode in ('live','test')),
  account_id text not null,
  session_id text not null,
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  payment_intent text,
  amount_cents bigint not null check (amount_cents between 1 and 100000000),
  currency text not null default 'usd' check (currency='usd'),
  received_cents bigint check (received_cents between amount_cents and 200000000),
  refunded_credit_cents bigint not null default 0 check (refunded_credit_cents between 0 and amount_cents),
  status text not null default 'checkout' check (status in ('checkout','pending','expired','failed','paid','partially_refunded','refunded')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (account_id=case billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end),
  check (session_id ~ ('^cs_'||billing_mode||'_[A-Za-z0-9]+$')),
  check (user_id like billing_mode||':supabase:%'),
  check (payment_intent is null or payment_intent ~ '^pi_[A-Za-z0-9]+$'),
  unique(account_id,session_id), unique(account_id,payment_intent)
);
create index if not exists pg_stripe_orders_owner on apiwild_finance.stripe_orders(user_id);

create table if not exists apiwild_finance.stripe_projection_events (
  account_id text not null,
  event_id text not null check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null,
  event_digest text not null check (event_digest ~ '^[a-f0-9]{64}$'),
  order_id uuid not null references apiwild_finance.stripe_orders(id),
  operation text not null check (operation in ('checkout','refund','dispute')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(account_id,event_id)
);
create table if not exists apiwild_finance.stripe_credit_entries (
  account_id text not null,
  source_id text not null,
  order_id uuid not null references apiwild_finance.stripe_orders(id),
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  amount_cents bigint not null check (amount_cents between -100000000 and 100000000 and amount_cents<>0),
  created_at timestamptz not null default clock_timestamp(),
  primary key(account_id,source_id)
);
create table if not exists apiwild_finance.stripe_disputes (
  account_id text not null,
  id text not null check (id ~ '^dp_[A-Za-z0-9]+$'),
  order_id uuid not null references apiwild_finance.stripe_orders(id),
  amount_cents bigint not null check (amount_cents between 1 and 200000000),
  status text not null check (status in ('needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented')),
  event_created bigint not null check (event_created between 0 and 9007199254740991),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(account_id,id)
);
alter table apiwild_finance.stripe_orders enable row level security;
alter table apiwild_finance.stripe_projection_events enable row level security;
alter table apiwild_finance.stripe_credit_entries enable row level security;
alter table apiwild_finance.stripe_disputes enable row level security;
revoke all on apiwild_finance.stripe_orders,apiwild_finance.stripe_projection_events,
  apiwild_finance.stripe_credit_entries,apiwild_finance.stripe_disputes from public,anon,authenticated,service_role;

create or replace function apiwild_finance.stripe_project_v1(
  p_account_id text,p_billing_mode text,p_event_id text,p_event_type text,
  p_event_digest text,p_event_created bigint,p_operation text,p_fact jsonb
) returns jsonb language plpgsql security definer set search_path=''
  set lock_timeout='5s' set statement_timeout='20s' as $$
declare
  o apiwild_finance.stripe_orders; a apiwild_finance.gateway_accounts;
  e apiwild_finance.stripe_projection_events; d apiwild_finance.stripe_disputes;
  v_delta bigint:=0; v_target bigint; v_hold numeric; v_prior_hold numeric; v_status text;
  v_total bigint; v_subtotal bigint; v_tax bigint; v_refunded bigint; v_received bigint;
  v_source text; v_inserted integer;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'stripe_isolation_unsupported'; end if;
  if p_billing_mode is null or p_billing_mode not in ('live','test')
    or p_account_id is distinct from (case p_billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end)
    or p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$'
    or p_event_digest is null or p_event_digest !~ '^[a-f0-9]{64}$'
    or p_event_created is null or p_event_created not between 0 and 9007199254740991
    or p_operation is null or p_operation not in ('checkout','refund','dispute')
    or p_fact is null or jsonb_typeof(p_fact)<>'object' or octet_length(p_fact::text)>8192
  then raise exception 'stripe_invalid_projection'; end if;
  if p_event_type is null or not (
    (p_operation='checkout' and p_event_type in ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'))
    or (p_operation='refund' and p_event_type in ('charge.refunded','refund.created','refund.updated','refund.failed'))
    or (p_operation='dispute' and p_event_type in ('charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'))
  ) then raise exception 'stripe_unsupported_event'; end if;
  -- Serialize duplicate envelopes before the owner lock. Gateway operations do
  -- not acquire this lock, so provider -> owner ordering is unchanged.
  perform pg_advisory_xact_lock(hashtextextended(p_account_id||':'||p_event_id,0));
  select * into e from apiwild_finance.stripe_projection_events where account_id=p_account_id and event_id=p_event_id;
  if found then
    if e.event_digest<>p_event_digest or e.event_type<>p_event_type or e.operation<>p_operation then raise exception 'stripe_event_conflict'; end if;
    return jsonb_build_object('applied',true,'replayed',true,'event_id',p_event_id,'operation',p_operation);
  end if;
  -- This lookup uses a previously registered canonical session/PI. No event
  -- customer/user metadata can create an order, bind an owner or grant credit.
  if p_operation='checkout' then
    select * into o from apiwild_finance.stripe_orders where account_id=p_account_id and session_id=p_fact->>'session_id';
  else
    select * into o from apiwild_finance.stripe_orders where account_id=p_account_id and payment_intent=p_fact->>'payment_intent';
  end if;
  if not found then raise exception 'stripe_order_unregistered'; end if;
  select * into a from apiwild_finance.gateway_accounts where user_id=o.user_id for update;
  if not found or a.billing_mode<>p_billing_mode or o.billing_mode<>p_billing_mode then raise exception 'stripe_owner_mismatch'; end if;
  select * into o from apiwild_finance.stripe_orders where id=o.id for update;
  if p_fact->>'order_id' is distinct from o.id::text or p_fact->>'customer_id' is distinct from o.stripe_customer_id
    or p_fact->>'currency' is distinct from o.currency then raise exception 'stripe_order_mismatch'; end if;
  -- Preserve any pre-existing/externally reconciled hold rather than silently
  -- releasing it during a partial ledger import. Only our verified delta is
  -- projected. An inconsistent prior projection fails closed for owner review.
  select coalesce(sum(least(s.amount_cents-s.refunded_credit_cents,x.held)),0)*10000 into v_prior_hold
    from apiwild_finance.stripe_orders s join (
      select order_id,sum(amount_cents) as held from apiwild_finance.stripe_disputes
      where status in ('needs_response','under_review','lost','warning_needs_response','warning_under_review') group by order_id
    ) x on x.order_id=s.id where s.user_id=o.user_id;
  if a.payment_hold_usd_micros<v_prior_hold then raise exception 'stripe_hold_reconciliation_required'; end if;
  if p_operation='checkout' then
    if p_fact-'order_id'-'session_id'-'customer_id'-'payment_intent'-'currency'-'subtotal_cents'-'total_cents'-'tax_cents'-'discount_cents'-'status'-'payment_status'<>'{}'::jsonb
      or jsonb_typeof(p_fact->'subtotal_cents') is distinct from 'number'
      or jsonb_typeof(p_fact->'total_cents') is distinct from 'number'
      or jsonb_typeof(p_fact->'tax_cents') is distinct from 'number'
      or jsonb_typeof(p_fact->'discount_cents') is distinct from 'number'
      or (p_fact->>'subtotal_cents') !~ '^[0-9]+$' or (p_fact->>'total_cents') !~ '^[0-9]+$'
      or (p_fact->>'tax_cents') !~ '^[0-9]+$' or p_fact->>'discount_cents' is distinct from '0'
    then raise exception 'stripe_invalid_checkout'; end if;
    v_subtotal:=(p_fact->>'subtotal_cents')::bigint; v_total:=(p_fact->>'total_cents')::bigint; v_tax:=(p_fact->>'tax_cents')::bigint;
    if v_subtotal<>o.amount_cents or v_total<>v_subtotal+v_tax or v_total>200000000
      or p_fact->>'status' not in ('open','complete','expired')
      or p_fact->>'payment_status' not in ('unpaid','paid','no_payment_required')
      or p_fact->>'status' is null or p_fact->>'payment_status' is null
    then raise exception 'stripe_invalid_checkout'; end if;
    if p_fact->>'status'='complete' and p_fact->>'payment_status'='paid' then
      if p_fact->>'payment_intent' is null or p_fact->>'payment_intent' !~ '^pi_[A-Za-z0-9]+$'
        or (o.payment_intent is not null and o.payment_intent<>p_fact->>'payment_intent')
        or (o.received_cents is not null and o.received_cents<>v_total)
      then raise exception 'stripe_payment_mismatch'; end if;
      v_source:='checkout:'||o.session_id;
      insert into apiwild_finance.stripe_credit_entries(account_id,source_id,order_id,user_id,amount_cents)
        values(p_account_id,v_source,o.id,o.user_id,o.amount_cents) on conflict do nothing;
      get diagnostics v_inserted=row_count;
      if v_inserted=1 then v_delta:=o.amount_cents;
      elsif not exists(select 1 from apiwild_finance.stripe_credit_entries where account_id=p_account_id and source_id=v_source
        and order_id=o.id and user_id=o.user_id and amount_cents=o.amount_cents) then raise exception 'stripe_credit_conflict'; end if;
      update apiwild_finance.stripe_orders set payment_intent=p_fact->>'payment_intent',received_cents=v_total,
        status=case when refunded_credit_cents=amount_cents then 'refunded' when refunded_credit_cents>0 then 'partially_refunded' else 'paid' end,
        updated_at=clock_timestamp() where id=o.id;
    elsif o.received_cents is null then
      v_status:=case when p_fact->>'status'='expired' then 'expired' when p_event_type='checkout.session.async_payment_failed' then 'failed' else 'pending' end;
      update apiwild_finance.stripe_orders set status=v_status,updated_at=clock_timestamp() where id=o.id;
    end if;
  else
    if o.received_cents is null or p_fact->>'payment_intent' is distinct from o.payment_intent then raise exception 'stripe_credit_not_reconciled'; end if;
    if p_operation='refund' then
      if p_fact-'order_id'-'customer_id'-'payment_intent'-'currency'-'received_cents'-'refunded_cents'<>'{}'::jsonb
        or jsonb_typeof(p_fact->'received_cents') is distinct from 'number' or jsonb_typeof(p_fact->'refunded_cents') is distinct from 'number'
        or (p_fact->>'received_cents') !~ '^[0-9]+$' or (p_fact->>'refunded_cents') !~ '^[0-9]+$'
      then raise exception 'stripe_invalid_refund'; end if;
      v_received:=(p_fact->>'received_cents')::bigint; v_refunded:=(p_fact->>'refunded_cents')::bigint;
      if v_received<>o.received_cents or v_refunded>v_received then raise exception 'stripe_refund_mismatch'; end if;
      -- Numeric arithmetic avoids overflow and never grants tax as AI credits.
      v_target:=floor(o.amount_cents::numeric*v_refunded/v_received)::bigint;
      if v_target>o.refunded_credit_cents then
        v_delta:=o.refunded_credit_cents-v_target;
        insert into apiwild_finance.stripe_credit_entries(account_id,source_id,order_id,user_id,amount_cents)
          values(p_account_id,'refund-total:'||o.id::text||':'||v_target,o.id,o.user_id,v_delta);
        update apiwild_finance.stripe_orders set refunded_credit_cents=v_target,
          status=case when v_target=amount_cents then 'refunded' else 'partially_refunded' end,updated_at=clock_timestamp() where id=o.id;
      end if;
    else
      if p_fact-'order_id'-'customer_id'-'payment_intent'-'currency'-'dispute_id'-'amount_cents'-'status'<>'{}'::jsonb
        or p_fact->>'dispute_id' is null or p_fact->>'dispute_id' !~ '^dp_[A-Za-z0-9]+$'
        or jsonb_typeof(p_fact->'amount_cents') is distinct from 'number' or (p_fact->>'amount_cents') !~ '^[0-9]+$'
        or (p_fact->>'amount_cents')::numeric not between 1 and o.received_cents
        or p_fact->>'status' is null or p_fact->>'status' not in ('needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented')
      then raise exception 'stripe_invalid_dispute'; end if;
      select * into d from apiwild_finance.stripe_disputes where account_id=p_account_id and id=p_fact->>'dispute_id';
      if found and (d.order_id<>o.id or d.amount_cents<>(p_fact->>'amount_cents')::bigint) then raise exception 'stripe_dispute_conflict'; end if;
      -- Terminal outcomes are absorbing. An older open snapshot cannot remove a
      -- lost hold or resurrect a won dispute. Conflicting terminal data is held.
      if found and d.status in ('won','lost','warning_closed','prevented') then
        if p_fact->>'status' in ('won','lost','warning_closed','prevented') and d.status<>p_fact->>'status' then raise exception 'stripe_dispute_terminal_conflict'; end if;
      elsif not found or p_event_created>=d.event_created then
        insert into apiwild_finance.stripe_disputes(account_id,id,order_id,amount_cents,status,event_created)
          values(p_account_id,p_fact->>'dispute_id',o.id,(p_fact->>'amount_cents')::bigint,p_fact->>'status',p_event_created)
          on conflict(account_id,id) do update set status=excluded.status,event_created=excluded.event_created,updated_at=clock_timestamp();
      end if;
    end if;
  end if;
  -- Per-order clamp avoids holding the same purchase twice. Lost funds remain
  -- held, not an invented double-debit; refunds proportionally reduce the hold.
  select coalesce(sum(least(s.amount_cents-s.refunded_credit_cents,x.held)),0)*10000 into v_hold
    from apiwild_finance.stripe_orders s join (
      select order_id,sum(amount_cents) as held from apiwild_finance.stripe_disputes
      where status in ('needs_response','under_review','lost','warning_needs_response','warning_under_review') group by order_id
    ) x on x.order_id=s.id where s.user_id=o.user_id;
  update apiwild_finance.gateway_accounts set funded_usd_micros=funded_usd_micros+v_delta*10000,
    payment_hold_usd_micros=a.payment_hold_usd_micros-v_prior_hold+v_hold,updated_at=clock_timestamp() where user_id=o.user_id;
  insert into apiwild_finance.stripe_projection_events(account_id,event_id,event_type,event_digest,order_id,operation)
    values(p_account_id,p_event_id,p_event_type,p_event_digest,o.id,p_operation);
  return jsonb_build_object('applied',true,'replayed',false,'event_id',p_event_id,'operation',p_operation);
end;
$$;
-- Keep the privileged implementation outside the exposed Data API schema.
-- The public wrapper has only fixed typed parameters; no table privileges or
-- arbitrary SQL are granted to its service caller.
create or replace function public.apiwild_stripe_project(
  p_account_id text,p_billing_mode text,p_event_id text,p_event_type text,
  p_event_digest text,p_event_created bigint,p_operation text,p_fact jsonb
) returns jsonb language sql security invoker set search_path=''
  set lock_timeout='5s' set statement_timeout='20s' as $$
  select apiwild_finance.stripe_project_v1(p_account_id,p_billing_mode,p_event_id,p_event_type,
    p_event_digest,p_event_created,p_operation,p_fact);
$$;
revoke all on function apiwild_finance.stripe_project_v1(text,text,text,text,text,bigint,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.apiwild_stripe_project(text,text,text,text,text,bigint,text,jsonb) from public,anon,authenticated,service_role;
grant usage on schema apiwild_finance to service_role;
grant execute on function apiwild_finance.stripe_project_v1(text,text,text,text,text,bigint,text,jsonb) to service_role;
grant execute on function public.apiwild_stripe_project(text,text,text,text,text,bigint,text,jsonb) to service_role;
commit;

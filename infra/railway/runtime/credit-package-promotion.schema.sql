-- Named prepaid packs: trusted, immutable checkout terms; no orders or funds seeded.
begin;
alter table apiwild_finance.stripe_orders add column bonus_cents bigint not null default 0 check(bonus_cents between 0 and 5500);
alter table apiwild_finance.stripe_orders add column credit_cents bigint generated always as(amount_cents+bonus_cents) stored;
alter table apiwild_finance.stripe_orders add column package_id text;
alter table apiwild_finance.stripe_orders add column promotion_id text;
alter table apiwild_finance.stripe_orders add column promo_starts_at timestamptz;
alter table apiwild_finance.stripe_orders add column promo_ends_at timestamptz;
alter table apiwild_finance.stripe_orders add column price_id text;
do $$declare c record;begin for c in select conname from pg_constraint where conrelid='apiwild_finance.stripe_orders'::regclass and contype='c' and position('refunded_credit_cents' in pg_get_constraintdef(oid))>0 and position('amount_cents' in pg_get_constraintdef(oid))>0 and position('bonus_cents' in pg_get_constraintdef(oid))=0 loop execute format('alter table apiwild_finance.stripe_orders drop constraint %I',c.conname);end loop;end;$$;
alter table apiwild_finance.stripe_orders add constraint stripe_orders_refunded_credit_cents_check check(refunded_credit_cents between 0 and amount_cents+bonus_cents);
create table apiwild_finance.stripe_credit_promotions(id text primary key check(id='apiwild-credit-packs-v1'),starts_at timestamptz not null,ends_at timestamptz not null,check(ends_at-starts_at=interval '15 days 31 minutes'));
create table apiwild_finance.stripe_checkout_intents(
 order_id uuid primary key,user_id text not null references apiwild_finance.gateway_accounts(user_id),billing_mode text not null,account_id text not null,
 price_id text not null,package_id text,amount_cents bigint not null,bonus_cents bigint not null default 0,
 credit_cents bigint generated always as(amount_cents+bonus_cents) stored,promotion_id text,promo_starts_at timestamptz,promo_ends_at timestamptz,
 expires_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),
 check(amount_cents between 3000 and 100000000 and amount_cents%100=0),check(bonus_cents between 0 and 5500),
 check(billing_mode in('live','test')),check(account_id=case billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end),check(user_id like billing_mode||':supabase:%'),check(price_id~'^price_[A-Za-z0-9]+$'));
alter table apiwild_finance.stripe_credit_promotions enable row level security;
alter table apiwild_finance.stripe_checkout_intents enable row level security;
revoke all on apiwild_finance.stripe_credit_promotions,apiwild_finance.stripe_checkout_intents from public,anon,authenticated,service_role;
create function apiwild_finance.stripe_order_terms_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.amount_cents,new.bonus_cents,new.package_id,new.promotion_id,new.promo_starts_at,new.promo_ends_at,new.price_id)
 is distinct from(old.amount_cents,old.bonus_cents,old.package_id,old.promotion_id,old.promo_starts_at,old.promo_ends_at,old.price_id) then raise exception 'checkout_terms_immutable';end if;return new;
end;$$;
create trigger stripe_order_terms_immutable before update on apiwild_finance.stripe_orders for each row execute function apiwild_finance.stripe_order_terms_immutable();
create or replace function public.apiwild_stripe_prepare_checkout(p_order_id uuid,p_user_id text,p_billing_mode text,p_account_id text,p_price_id text,p_package_id text,p_amount_cents bigint,p_promo_starts_at timestamptz,p_promo_ends_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare q apiwild_finance.stripe_checkout_intents;o apiwild_finance.stripe_orders;w apiwild_finance.stripe_credit_promotions;v_bonus bigint:=0;v_paid bigint;v_now timestamptz:=clock_timestamp();v_end timestamptz;v_id text;
begin
 if p_order_id is null or p_billing_mode is null or p_billing_mode not in('live','test') or p_account_id is distinct from(case p_billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end)
 or p_user_id is null or p_user_id!~('^'||p_billing_mode||':supabase:[0-9a-f-]{36}$') or p_price_id is null or p_price_id!~'^price_[A-Za-z0-9]+$' then raise exception 'checkout_invalid_intent';end if;
 if p_package_id is null then v_paid:=p_amount_cents;
 else select paid,bonus into v_paid,v_bonus from(values('smart',7700::bigint,1300::bigint),('nerd',10100,1900),('newton',23400,2600),('alien',34500,5500)) x(id,paid,bonus) where id=p_package_id;if not found then raise exception 'checkout_unknown_package';end if;end if;
 if p_amount_cents is null or v_paid is null or p_amount_cents<>v_paid or v_paid not between 3000 and 100000000 or v_paid%100<>0 then raise exception 'checkout_invalid_amount';end if;
 perform pg_advisory_xact_lock(hashtextextended('checkout:'||p_order_id::text,0));
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_user_id and billing_mode=p_billing_mode and not suspended for update;if not found then raise exception 'checkout_account_unregistered';end if;
 select * into o from apiwild_finance.stripe_orders where id=p_order_id;
 select * into q from apiwild_finance.stripe_checkout_intents where order_id=p_order_id;
 if found then
  if(q.user_id,q.billing_mode,q.account_id,q.price_id,q.package_id,q.amount_cents) is distinct from(p_user_id,p_billing_mode,p_account_id,p_price_id,p_package_id,v_paid) then raise exception 'checkout_intent_conflict';end if;
 elsif o.id is not null then
  if(o.user_id,o.billing_mode,o.account_id,o.amount_cents,o.package_id) is distinct from(p_user_id,p_billing_mode,p_account_id,v_paid,p_package_id) then raise exception 'checkout_registration_conflict';end if;
  insert into apiwild_finance.stripe_checkout_intents(order_id,user_id,billing_mode,account_id,price_id,package_id,amount_cents,bonus_cents,promotion_id,promo_starts_at,promo_ends_at,expires_at)
  values(p_order_id,p_user_id,p_billing_mode,p_account_id,p_price_id,p_package_id,v_paid,o.bonus_cents,o.promotion_id,o.promo_starts_at,o.promo_ends_at,v_now+interval '1 hour') returning * into q;
 else
  if(p_promo_starts_at is null)<>(p_promo_ends_at is null) or(p_promo_starts_at is not null and p_promo_ends_at-p_promo_starts_at<>interval '15 days 31 minutes') then raise exception 'checkout_invalid_promotion';end if;
  if p_promo_starts_at is not null then
   insert into apiwild_finance.stripe_credit_promotions values('apiwild-credit-packs-v1',p_promo_starts_at,p_promo_ends_at) on conflict do nothing;
   select * into w from apiwild_finance.stripe_credit_promotions where id='apiwild-credit-packs-v1';
   if(w.starts_at,w.ends_at) is distinct from(p_promo_starts_at,p_promo_ends_at) then raise exception 'checkout_promotion_immutable';end if;
  end if;
  v_end:=date_trunc('second',v_now)+interval '1 hour';
  if p_package_id is not null and p_promo_starts_at is not null and v_now>=p_promo_starts_at and v_now<p_promo_ends_at-interval '31 minutes' then v_id:='apiwild-credit-packs-v1';v_end:=least(v_end,p_promo_ends_at);else v_bonus:=0;end if;
  insert into apiwild_finance.stripe_checkout_intents(order_id,user_id,billing_mode,account_id,price_id,package_id,amount_cents,bonus_cents,promotion_id,promo_starts_at,promo_ends_at,expires_at)
  values(p_order_id,p_user_id,p_billing_mode,p_account_id,p_price_id,p_package_id,v_paid,v_bonus,v_id,case when v_id is not null then p_promo_starts_at end,case when v_id is not null then p_promo_ends_at end,v_end) returning * into q;
 end if;
 return to_jsonb(q)||jsonb_build_object('prepared',true,'session_id',o.session_id,'legacy_order',o.id is not null and o.price_id is null);
end;$$;
revoke all on function public.apiwild_stripe_prepare_checkout(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.apiwild_stripe_prepare_checkout(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz) to service_role;
create or replace function public.apiwild_stripe_register_checkout(
 p_order_id uuid,p_user_id text,p_billing_mode text,p_account_id text,
 p_session_id text,p_customer_id text,p_amount_cents bigint
) returns jsonb language plpgsql security definer set search_path=''
 set lock_timeout='5s' set statement_timeout='15s' as $$
declare o apiwild_finance.stripe_orders;q apiwild_finance.stripe_checkout_intents;
begin
 if p_order_id is null or p_billing_mode is null or p_billing_mode not in ('live','test')
 or p_account_id is distinct from (case p_billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end)
 or p_user_id is null or p_user_id !~ ('^'||p_billing_mode||':supabase:[0-9a-f-]{36}$')
 or p_session_id is null or p_session_id !~ ('^cs_'||p_billing_mode||'_[A-Za-z0-9]+$')
 or p_customer_id is null or p_customer_id !~ '^cus_[A-Za-z0-9]+$'
 or p_amount_cents is null or p_amount_cents<3000 or p_amount_cents>100000000 or p_amount_cents%100<>0
 then raise exception 'checkout_invalid_registration'; end if;
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_user_id and not suspended for update;
 if not found then raise exception 'checkout_account_unregistered'; end if;
 select * into q from apiwild_finance.stripe_checkout_intents where order_id=p_order_id;
 if found and(q.user_id,q.billing_mode,q.account_id,q.amount_cents) is distinct from(p_user_id,p_billing_mode,p_account_id,p_amount_cents) then raise exception 'checkout_intent_conflict';end if;
 insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents,bonus_cents,package_id,promotion_id,promo_starts_at,promo_ends_at,price_id)
 values(p_order_id,p_user_id,p_billing_mode,p_account_id,p_session_id,p_customer_id,p_amount_cents,coalesce(q.bonus_cents,0),q.package_id,q.promotion_id,q.promo_starts_at,q.promo_ends_at,q.price_id)
 on conflict(id) do nothing;
 select * into o from apiwild_finance.stripe_orders where id=p_order_id for update;
 if o.user_id<>p_user_id or o.billing_mode<>p_billing_mode or o.account_id<>p_account_id
 or(q.order_id is not null and((o.bonus_cents,o.package_id,o.promotion_id) is distinct from(q.bonus_cents,q.package_id,q.promotion_id) or(o.price_id is not null and o.price_id is distinct from q.price_id)))
 or o.session_id<>p_session_id or o.stripe_customer_id<>p_customer_id or o.amount_cents<>p_amount_cents
 then raise exception 'checkout_registration_conflict'; end if;
 return jsonb_build_object('registered',true,'order_id',o.id,'session_id',o.session_id);
end;
$$;
revoke all on function public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) to service_role;

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
  select coalesce(sum(least(s.credit_cents-s.refunded_credit_cents,case when s.bonus_cents>0 then floor(s.credit_cents::numeric*x.held/s.received_cents) else x.held end)),0)*10000 into v_prior_hold
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
        values(p_account_id,v_source,o.id,o.user_id,o.credit_cents) on conflict do nothing;
      get diagnostics v_inserted=row_count;
      if v_inserted=1 then v_delta:=o.credit_cents;
      elsif not exists(select 1 from apiwild_finance.stripe_credit_entries where account_id=p_account_id and source_id=v_source
        and order_id=o.id and user_id=o.user_id and amount_cents=o.credit_cents) then raise exception 'stripe_credit_conflict'; end if;
      update apiwild_finance.stripe_orders set payment_intent=p_fact->>'payment_intent',received_cents=v_total,
        status=case when refunded_credit_cents=credit_cents then 'refunded' when refunded_credit_cents>0 then 'partially_refunded' else 'paid' end,
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
      v_target:=floor(o.credit_cents::numeric*v_refunded/v_received)::bigint;
      if v_target>o.refunded_credit_cents then
        v_delta:=o.refunded_credit_cents-v_target;
        insert into apiwild_finance.stripe_credit_entries(account_id,source_id,order_id,user_id,amount_cents)
          values(p_account_id,'refund-total:'||o.id::text||':'||v_target,o.id,o.user_id,v_delta);
        update apiwild_finance.stripe_orders set refunded_credit_cents=v_target,
          status=case when v_target=credit_cents then 'refunded' else 'partially_refunded' end,updated_at=clock_timestamp() where id=o.id;
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
  select coalesce(sum(least(s.credit_cents-s.refunded_credit_cents,case when s.bonus_cents>0 then floor(s.credit_cents::numeric*x.held/s.received_cents) else x.held end)),0)*10000 into v_hold
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

create or replace function public.apiwild_billing_read(p_owner text,p_session text default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare a apiwild_finance.gateway_accounts; usage bigint; orders jsonb;
begin
 select * into a from apiwild_finance.gateway_accounts where user_id=p_owner;
 if not found then raise exception 'account_unregistered';end if;
 select coalesce(sum(coalesce(cost_usd_micros,0)+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0) into usage from apiwild_finance.gateway_requests where user_id=p_owner;
 select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) into orders from (select * from(select id,session_id,amount_cents,bonus_cents,credit_cents,package_id,promotion_id,currency,status,created_at from apiwild_finance.stripe_orders where user_id=p_owner and (p_session is null or session_id=p_session) union all select q.order_id,null::text,q.amount_cents,q.bonus_cents,q.credit_cents,q.package_id,q.promotion_id,'usd'::text,'expired'::text,q.created_at from apiwild_finance.stripe_checkout_intents q where q.user_id=p_owner and p_session is null and q.expires_at<=clock_timestamp() and not exists(select 1 from apiwild_finance.stripe_orders o where o.id=q.order_id)) h order by created_at desc limit 50)x;
 return jsonb_build_object('suspended',a.suspended,'balanceCents',floor((a.funded_usd_micros-a.payment_hold_usd_micros-usage)::numeric/10000),'orders',orders);
end;$$;


-- Bonus changes owned retail credit only; native supplier quota still maps paid principal.
create or replace function apiwild_finance.allowance_sync(p_owner text,p_order uuid)
returns apiwild_finance.supplier_allowance_outbox language plpgsql security definer set search_path=''
set lock_timeout='5s' set statement_timeout='20s' as $$
declare a apiwild_finance.gateway_accounts;o apiwild_finance.stripe_orders;
  q apiwild_finance.supplier_allowance_outbox;m apiwild_finance.supplier_allowance_mapping; eligible boolean;
begin
  select * into a from apiwild_finance.gateway_accounts where user_id=p_owner for update;
  if not found then raise exception 'allowance_owner_missing';end if;
  select * into o from apiwild_finance.stripe_orders where id=p_order and user_id=p_owner for update;
  if not found then raise exception 'allowance_order_missing';end if;
  if o.received_cents is not null then
    insert into apiwild_finance.supplier_allowance_outbox(order_id,user_id) values(o.id,o.user_id) on conflict do nothing;
  end if;
  select * into q from apiwild_finance.supplier_allowance_outbox where order_id=o.id and user_id=p_owner for update;
  if not found then return null;end if;
  eligible:=o.status='paid' and o.refunded_credit_cents=0 and o.received_cents>=o.amount_cents
    and o.payment_intent is not null and not a.suspended and a.payment_hold_usd_micros=0
    and exists(select 1 from apiwild_finance.stripe_credit_entries where account_id=o.account_id
      and order_id=o.id and user_id=o.user_id and source_id='checkout:'||o.session_id and amount_cents=o.credit_cents)
    and not exists(select 1 from apiwild_finance.stripe_disputes where order_id=o.id
      and status in ('needs_response','under_review','lost','warning_needs_response','warning_under_review'));
  if not coalesce(eligible,false) then
    if q.state in ('executing','uncertain','activated','review') then
      update apiwild_finance.gateway_accounts set suspended=true where user_id=p_owner;
      update apiwild_finance.supplier_allowance_outbox set state='review',updated_at=clock_timestamp() where order_id=o.id returning * into q;
    else
      update apiwild_finance.supplier_allowance_outbox set state='blocked',updated_at=clock_timestamp() where order_id=o.id returning * into q;
    end if;
    return q;
  end if;
  select * into m from apiwild_finance.supplier_allowance_mapping where order_id=o.id and user_id=p_owner;
  if q.state='awaiting_mapping' then
    if found and m.accepted and m.paid_credit_cents=o.amount_cents then
      update apiwild_finance.supplier_allowance_outbox set state='pending',native_user_id=m.native_user_id,
        package_id=m.package_id,expected_quota=m.expected_quota,code_reference=m.code_reference,code_sha256=m.code_sha256,
        quota_policy_sha256=m.quota_policy_sha256,updated_at=clock_timestamp() where order_id=o.id returning * into q;
    end if;
  elsif q.state in ('pending','executing','uncertain','activated') then
    if m.order_id is null or not m.accepted or m.paid_credit_cents<>o.amount_cents
      or (q.native_user_id,q.package_id,q.expected_quota,q.code_reference,q.code_sha256,q.quota_policy_sha256)
        is distinct from (m.native_user_id,m.package_id,m.expected_quota,m.code_reference,m.code_sha256,m.quota_policy_sha256) then
      if q.state<>'pending' then update apiwild_finance.gateway_accounts set suspended=true where user_id=p_owner;end if;
      update apiwild_finance.supplier_allowance_outbox set state=case when q.state='pending' then 'blocked' else 'review' end,
        updated_at=clock_timestamp() where order_id=o.id returning * into q;
    end if;
  end if;
  return q;
end;$$;

commit;

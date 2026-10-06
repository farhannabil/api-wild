-- One owner-bound real prepaid checkout. No wallet credit, orders or enrollment seeded.
begin;
create table apiwild_finance.temporary_credit_offers(
 user_id text primary key references apiwild_finance.gateway_accounts(user_id),
 price_id text not null check(price_id~'^price_[A-Za-z0-9]+$'),
 ends_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),
 order_id uuid unique references apiwild_finance.stripe_checkout_intents(order_id),
 check(user_id~'^(live|test):supabase:[0-9a-f-]{36}$'),
 check(ends_at>created_at and ends_at<=created_at+interval '24 hours')
);
alter table apiwild_finance.temporary_credit_offers enable row level security;
revoke all on apiwild_finance.temporary_credit_offers from public,anon,authenticated,service_role;
-- IS [NOT] DISTINCT FROM prevents NULL package IDs bypassing either amount arm.
do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='apiwild_finance.stripe_checkout_intents'::regclass
  and contype='c' and position('amount_cents' in pg_get_constraintdef(oid))>0 and position('3000' in pg_get_constraintdef(oid))>0
 loop execute format('alter table apiwild_finance.stripe_checkout_intents drop constraint %I',c.conname);end loop;
end;$$;
alter table apiwild_finance.stripe_checkout_intents add constraint stripe_intents_bound_amount check(
 (package_id is not distinct from 'launch-dollar' and amount_cents=100 and bonus_cents=0 and promotion_id is null and promo_starts_at is null and promo_ends_at is null)
 or(package_id is distinct from 'launch-dollar' and amount_cents between 3000 and 100000000 and amount_cents%100=0));
alter table apiwild_finance.stripe_orders add constraint stripe_orders_bound_amount check(
 (package_id is not distinct from 'launch-dollar' and amount_cents=100 and bonus_cents=0 and promotion_id is null and promo_starts_at is null and promo_ends_at is null and price_id is not null)
 or(package_id is distinct from 'launch-dollar' and amount_cents between 3000 and 100000000 and amount_cents%100=0));

create function public.apiwild_temporary_credit_offer_enroll(p_owner text,p_price_id text,p_ends_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare q apiwild_finance.temporary_credit_offers;v_now timestamptz:=clock_timestamp();begin
 if p_owner is null or p_owner!~'^(live|test):supabase:[0-9a-f-]{36}$' or p_price_id is null or p_price_id!~'^price_[A-Za-z0-9]+$'
  or p_ends_at is null then raise exception 'temporary_offer_invalid';end if;
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner and billing_mode=split_part(p_owner,':',1) and not suspended for update;
 if not found then raise exception 'temporary_offer_owner_unavailable';end if;
 select * into q from apiwild_finance.temporary_credit_offers where user_id=p_owner for update;
 if found then if(q.price_id,q.ends_at) is distinct from(p_price_id,p_ends_at) then raise exception 'temporary_offer_immutable';end if;
 else
  if p_ends_at<v_now+interval '31 minutes' or p_ends_at>v_now+interval '24 hours' then raise exception 'temporary_offer_invalid';end if;
  insert into apiwild_finance.temporary_credit_offers(user_id,price_id,ends_at,created_at) values(p_owner,p_price_id,p_ends_at,v_now) returning * into q;
 end if;
 return jsonb_build_object('enrolled',true,'user_id',q.user_id,'price_id',q.price_id,'ends_at',q.ends_at);
end;$$;
create function public.apiwild_temporary_credit_offer_read(p_owner text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q apiwild_finance.temporary_credit_offers;v_eligible boolean;begin
 select * into q from apiwild_finance.temporary_credit_offers where user_id=p_owner;
 if not found then return jsonb_build_object('eligible',false);end if;
 v_eligible:=clock_timestamp()<=q.ends_at-interval '31 minutes'
  and exists(select 1 from apiwild_finance.gateway_accounts where user_id=p_owner and not suspended)
  and(q.order_id is null or exists(select 1 from apiwild_finance.stripe_checkout_intents i where i.order_id=q.order_id and i.expires_at>=clock_timestamp()+interval '31 minutes'
   and not exists(select 1 from apiwild_finance.stripe_orders o where o.id=q.order_id and o.status not in('checkout','pending'))));
 return jsonb_build_object('eligible',v_eligible,'user_id',q.user_id,'price_id',q.price_id,'ends_at',q.ends_at,'order_id',q.order_id);
end;$$;

-- Keep the established standard pack/custom implementations unchanged and private.
alter function public.apiwild_stripe_prepare_checkout(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz) set schema apiwild_finance;
alter function apiwild_finance.apiwild_stripe_prepare_checkout(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz) rename to stripe_prepare_standard_v1;
revoke all on function apiwild_finance.stripe_prepare_standard_v1(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz) from public,anon,authenticated,service_role;
alter function public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) set schema apiwild_finance;
alter function apiwild_finance.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) rename to stripe_register_standard_v1;
revoke all on function apiwild_finance.stripe_register_standard_v1(uuid,text,text,text,text,text,bigint) from public,anon,authenticated,service_role;

create function public.apiwild_stripe_prepare_checkout(p_order_id uuid,p_user_id text,p_billing_mode text,p_account_id text,p_price_id text,p_package_id text,p_amount_cents bigint,p_promo_starts_at timestamptz,p_promo_ends_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare q apiwild_finance.stripe_checkout_intents;o apiwild_finance.stripe_orders;e apiwild_finance.temporary_credit_offers;v_now timestamptz:=clock_timestamp();v_end timestamptz;begin
 if p_package_id is distinct from 'launch-dollar' then return apiwild_finance.stripe_prepare_standard_v1(p_order_id,p_user_id,p_billing_mode,p_account_id,p_price_id,p_package_id,p_amount_cents,p_promo_starts_at,p_promo_ends_at);end if;
 if p_order_id is null or p_user_id is null or p_billing_mode is null or p_billing_mode not in('live','test')
  or p_user_id!~('^'||p_billing_mode||':supabase:[0-9a-f-]{36}$')
  or p_account_id is distinct from(case p_billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end)
  or p_amount_cents is distinct from 100::bigint or p_promo_starts_at is not null or p_promo_ends_at is not null then raise exception 'temporary_offer_invalid';end if;
 perform pg_advisory_xact_lock(hashtextextended('checkout:'||p_order_id::text,0));
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_user_id and billing_mode=p_billing_mode and not suspended for update;
 if not found then raise exception 'temporary_offer_owner_unavailable';end if;
 select * into e from apiwild_finance.temporary_credit_offers where user_id=p_user_id for update;
 if not found or e.price_id is distinct from p_price_id or v_now>e.ends_at-interval '31 minutes' then raise exception 'temporary_offer_unavailable';end if;
 if e.order_id is not null and e.order_id<>p_order_id then raise exception 'temporary_offer_already_used';end if;
 select * into q from apiwild_finance.stripe_checkout_intents where order_id=p_order_id;
 if found then
  if(q.user_id,q.billing_mode,q.account_id,q.price_id,q.package_id,q.amount_cents,q.bonus_cents,q.promotion_id,q.promo_starts_at,q.promo_ends_at)
   is distinct from(p_user_id,p_billing_mode,p_account_id,p_price_id,'launch-dollar'::text,100::bigint,0::bigint,null::text,null::timestamptz,null::timestamptz)
   or q.expires_at>e.ends_at or q.expires_at<v_now+interval '31 minutes' then raise exception 'temporary_offer_intent_conflict';end if;
 else
  v_end:=least(date_trunc('second',v_now)+interval '1 hour',date_trunc('second',e.ends_at));
  if v_end<v_now+interval '31 minutes' then raise exception 'temporary_offer_unavailable';end if;
  insert into apiwild_finance.stripe_checkout_intents(order_id,user_id,billing_mode,account_id,price_id,package_id,amount_cents,expires_at)
   values(p_order_id,p_user_id,p_billing_mode,p_account_id,p_price_id,'launch-dollar',100,v_end) returning * into q;
 end if;
 update apiwild_finance.temporary_credit_offers set order_id=p_order_id where user_id=p_user_id;
 select * into o from apiwild_finance.stripe_orders where id=p_order_id;
 return to_jsonb(q)||jsonb_build_object('prepared',true,'session_id',o.session_id,'legacy_order',false);
end;$$;

create function public.apiwild_stripe_register_checkout(p_order_id uuid,p_user_id text,p_billing_mode text,p_account_id text,p_session_id text,p_customer_id text,p_amount_cents bigint)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='15s' as $$
declare q apiwild_finance.stripe_checkout_intents;o apiwild_finance.stripe_orders;e apiwild_finance.temporary_credit_offers;begin
 if p_amount_cents is distinct from 100::bigint then return apiwild_finance.stripe_register_standard_v1(p_order_id,p_user_id,p_billing_mode,p_account_id,p_session_id,p_customer_id,p_amount_cents);end if;
 if p_order_id is null or p_user_id is null or p_billing_mode is null or p_billing_mode not in('live','test')
  or p_account_id is distinct from(case p_billing_mode when 'live' then 'acct_1UCiHN194XZKj6cF' else 'acct_1UCiHk0SGcPsf6AA' end)
  or p_user_id!~('^'||p_billing_mode||':supabase:[0-9a-f-]{36}$') or p_session_id is null or p_session_id!~('^cs_'||p_billing_mode||'_[A-Za-z0-9]+$')
  or p_customer_id is null or p_customer_id!~'^cus_[A-Za-z0-9]+$' then raise exception 'temporary_offer_invalid_registration';end if;
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_user_id and billing_mode=p_billing_mode and not suspended for update;
 if not found then raise exception 'temporary_offer_owner_unavailable';end if;
 select * into e from apiwild_finance.temporary_credit_offers where user_id=p_user_id for update;
 select * into q from apiwild_finance.stripe_checkout_intents where order_id=p_order_id;
 if e.order_id is distinct from p_order_id or(q.user_id,q.billing_mode,q.account_id,q.price_id,q.package_id,q.amount_cents,q.bonus_cents,q.promotion_id,q.promo_starts_at,q.promo_ends_at)
  is distinct from(p_user_id,p_billing_mode,p_account_id,e.price_id,'launch-dollar'::text,100::bigint,0::bigint,null::text,null::timestamptz,null::timestamptz)
  or q.expires_at is null or q.expires_at>e.ends_at then raise exception 'temporary_offer_intent_conflict';end if;
 select * into o from apiwild_finance.stripe_orders where id=p_order_id for update;
 -- Existing registered sessions remain retriable/reconcilable after offer expiry.
 if o.id is null then
  if clock_timestamp()>=q.expires_at then raise exception 'temporary_offer_expired';end if;
  insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents,bonus_cents,package_id,price_id)
   values(p_order_id,p_user_id,p_billing_mode,p_account_id,p_session_id,p_customer_id,100,0,'launch-dollar',e.price_id) returning * into o;
 end if;
 if(o.user_id,o.billing_mode,o.account_id,o.session_id,o.stripe_customer_id,o.amount_cents,o.bonus_cents,o.package_id,o.price_id)
  is distinct from(p_user_id,p_billing_mode,p_account_id,p_session_id,p_customer_id,100::bigint,0::bigint,'launch-dollar'::text,e.price_id) then raise exception 'checkout_registration_conflict';end if;
 return jsonb_build_object('registered',true,'order_id',o.id,'session_id',o.session_id);
end;$$;
revoke all on function public.apiwild_temporary_credit_offer_enroll(text,text,timestamptz),public.apiwild_temporary_credit_offer_read(text),public.apiwild_stripe_prepare_checkout(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz),public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.apiwild_temporary_credit_offer_enroll(text,text,timestamptz),public.apiwild_temporary_credit_offer_read(text),public.apiwild_stripe_prepare_checkout(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz),public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) to service_role;
commit;

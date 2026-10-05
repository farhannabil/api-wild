-- API WILD checkout registration and durable customer mapping migration.
-- Service-only trusted registration, never a browser-accessible credit grant.
begin;
create or replace function public.apiwild_stripe_register_checkout(
 p_order_id uuid,p_user_id text,p_billing_mode text,p_account_id text,
 p_session_id text,p_customer_id text,p_amount_cents bigint
) returns jsonb language plpgsql security definer set search_path=''
 set lock_timeout='5s' set statement_timeout='15s' as $$
declare o apiwild_finance.stripe_orders;
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
 insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents)
 values(p_order_id,p_user_id,p_billing_mode,p_account_id,p_session_id,p_customer_id,p_amount_cents)
 on conflict(id) do nothing;
 select * into o from apiwild_finance.stripe_orders where id=p_order_id for update;
 if o.user_id<>p_user_id or o.billing_mode<>p_billing_mode or o.account_id<>p_account_id
 or o.session_id<>p_session_id or o.stripe_customer_id<>p_customer_id or o.amount_cents<>p_amount_cents
 then raise exception 'checkout_registration_conflict'; end if;
 return jsonb_build_object('registered',true,'order_id',o.id,'session_id',o.session_id);
end;
$$;
revoke all on function public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.apiwild_stripe_register_checkout(uuid,text,text,text,text,text,bigint) to service_role;
commit;
begin;
create table if not exists apiwild_finance.stripe_customers(user_id text primary key references apiwild_finance.gateway_accounts(user_id),customer_id text not null unique check(customer_id~'^cus_[A-Za-z0-9]+$'));
alter table apiwild_finance.stripe_customers enable row level security;
revoke all on apiwild_finance.stripe_customers from public,anon,authenticated,service_role;
create or replace function public.apiwild_stripe_customer(p_owner text,p_customer text default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare c text;
begin
 perform 1 from apiwild_finance.gateway_accounts where user_id=p_owner for update;
 if not found then raise exception 'account_unregistered'; end if;
 if p_customer is not null then
  if p_customer!~'^cus_[A-Za-z0-9]+$' then raise exception 'invalid_customer';end if;
  insert into apiwild_finance.stripe_customers values(p_owner,p_customer) on conflict(user_id) do nothing;
 end if;
 select customer_id into c from apiwild_finance.stripe_customers where user_id=p_owner;
 return jsonb_build_object('customerId',c);
end;$$;
create or replace function public.apiwild_billing_read(p_owner text,p_session text default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare a apiwild_finance.gateway_accounts; usage bigint; orders jsonb;
begin
 select * into a from apiwild_finance.gateway_accounts where user_id=p_owner;
 if not found then raise exception 'account_unregistered';end if;
 select coalesce(sum(coalesce(cost_usd_micros,0)+case when state in ('reserved','executing','uncertain') then reserved_usd_micros else 0 end),0) into usage from apiwild_finance.gateway_requests where user_id=p_owner;
 select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) into orders from (select id,session_id,amount_cents,currency,status,created_at from apiwild_finance.stripe_orders where user_id=p_owner and (p_session is null or session_id=p_session) order by created_at desc limit 50)x;
 return jsonb_build_object('suspended',a.suspended,'balanceCents',floor((a.funded_usd_micros-a.payment_hold_usd_micros-usage)::numeric/10000),'orders',orders);
end;$$;
revoke all on function public.apiwild_stripe_customer(text,text),public.apiwild_billing_read(text,text) from public,anon,authenticated;
grant execute on function public.apiwild_stripe_customer(text,text),public.apiwild_billing_read(text,text) to service_role;
commit;

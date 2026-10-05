-- UNREGISTERED SCHEMA PROPOSAL. Not an applied Supabase migration.
-- Requires the existing gateway, Stripe projection and retail/supplier migrations.
-- No mappings, codes, money, credentials, supplier budgets or schedules are seeded.
-- Trusted operator mapping is per order: native quota has NO assumed USD conversion.
begin;

create table apiwild_finance.supplier_allowance_mapping (
  order_id uuid primary key references apiwild_finance.stripe_orders(id),
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  native_user_id integer not null check(native_user_id>0),
  package_id integer not null check(package_id>0),
  paid_credit_cents bigint not null check(paid_credit_cents between 1 and 100000000),
  expected_quota bigint not null check(expected_quota between 1 and 9007199254740991),
  quota_policy_sha256 text not null check(quota_policy_sha256 ~ '^[a-f0-9]{64}$'),
  code_reference uuid not null unique,
  code_sha256 text not null unique check(code_sha256 ~ '^[a-f0-9]{64}$'),
  accepted boolean not null default false
);
create table apiwild_finance.supplier_allowance_outbox (
  order_id uuid primary key references apiwild_finance.stripe_orders(id),
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  state text not null default 'awaiting_mapping' check(state in ('awaiting_mapping','pending','executing','uncertain','activated','blocked','review')),
  version bigint not null default 0 check(version between 0 and 9007199254740991),
  native_user_id integer, package_id integer, expected_quota bigint,
  code_reference uuid, code_sha256 text, quota_policy_sha256 text,
  claimed_at timestamptz, receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(receipt is null or octet_length(receipt::text)<=2048)
);
create table apiwild_finance.supplier_debit_receipts (
  request_id uuid primary key references apiwild_finance.gateway_requests(id),
  user_id text not null references apiwild_finance.gateway_accounts(user_id),
  key_reference uuid not null,
  receipt_id text not null,
  fact jsonb not null,
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  reconciled boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(key_reference,receipt_id),
  check(octet_length(fact::text)<=4096)
);
alter table apiwild_finance.supplier_allowance_mapping enable row level security;
alter table apiwild_finance.supplier_allowance_outbox enable row level security;
alter table apiwild_finance.supplier_debit_receipts enable row level security;
revoke all on apiwild_finance.supplier_allowance_mapping,apiwild_finance.supplier_allowance_outbox,
  apiwild_finance.supplier_debit_receipts from public,anon,authenticated,service_role;

-- This is a server worker authority, not customer impersonation. A customer JWT
-- must never be accepted even if a future caller mistakenly broadens grants.
create function apiwild_finance.allowance_assert_server() returns void
language plpgsql security invoker set search_path='' as $$ begin
  if current_setting('role',true) is distinct from 'service_role' or auth.uid() is not null
    then raise exception 'supplier_server_only'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'supplier_isolation_unsupported';end if;
end;$$;

-- Lock order matches Stripe: account -> order -> outbox. A refund/dispute
-- cannot silently release or retry an activation that may already have happened.
create function apiwild_finance.allowance_sync(p_owner text,p_order uuid)
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
      and order_id=o.id and user_id=o.user_id and source_id='checkout:'||o.session_id and amount_cents=o.amount_cents)
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

-- Durable enqueue is in the same transaction as the canonical Stripe order
-- update. It does not contact Subrouter. Existing paid orders need a reviewed
-- backfill via claim; installing the schema never grants retroactive quotas.
create function apiwild_finance.allowance_payment_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare o apiwild_finance.stripe_orders;
begin
  if TG_TABLE_NAME='stripe_orders' then o:=new;
  else select * into o from apiwild_finance.stripe_orders where id=new.order_id;end if;
  if o.id is not null then perform apiwild_finance.allowance_sync(o.user_id,o.id);end if;
  return new;
end;$$;
create trigger apiwild_allowance_payment after update of status,received_cents,refunded_credit_cents
  on apiwild_finance.stripe_orders for each row execute function apiwild_finance.allowance_payment_changed();
create trigger apiwild_allowance_dispute after insert or update of status
  on apiwild_finance.stripe_disputes for each row execute function apiwild_finance.allowance_payment_changed();

create function apiwild_finance.allowance_operate(p_op text,p_owner text,p_order uuid,p_version bigint default null,p_receipt jsonb default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare q apiwild_finance.supplier_allowance_outbox;r jsonb;
begin
  perform apiwild_finance.allowance_assert_server();
  if p_op not in ('claim','guard','finish','uncertain') or p_owner is null or p_order is null then raise exception 'allowance_invalid_operation';end if;
  q:=apiwild_finance.allowance_sync(p_owner,p_order);
  if q.order_id is null then return jsonb_build_object('claimed',false,'state','unpaid');end if;
  if p_op='claim' then
    if q.state<>'pending' then return jsonb_build_object('claimed',false,'state',q.state);end if;
    update apiwild_finance.supplier_allowance_outbox set state='executing',version=version+1,
      claimed_at=clock_timestamp(),updated_at=clock_timestamp() where order_id=p_order returning * into q;
    r:=jsonb_build_object('order_id',q.order_id,'user_id',q.user_id,'state',q.state,'version',q.version,
      'native_user_id',q.native_user_id,'package_id',q.package_id,'expected_quota',q.expected_quota,
      'code_reference',q.code_reference,'code_sha256',q.code_sha256);
    return jsonb_build_object('claimed',true,'record',r);
  end if;
  if p_version is null or p_version<>q.version then raise exception 'allowance_stale_claim';end if;
  if p_op='guard' then
    return jsonb_build_object('dispatch',q.state='executing' and q.claimed_at>clock_timestamp()-interval '30 seconds');
  elsif p_op='uncertain' then
    if q.state='executing' then update apiwild_finance.supplier_allowance_outbox set state='uncertain',updated_at=clock_timestamp() where order_id=p_order;end if;
    return jsonb_build_object('held',true);
  end if;
  if p_receipt is null or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>2048
    or p_receipt-'order_id'-'user_id'-'package_id'-'quota_redeemed'-'already_activated'<>'{}'::jsonb
    or p_receipt->>'order_id' is distinct from p_order::text
    or p_receipt->'user_id' is distinct from to_jsonb(q.native_user_id)
    or p_receipt->'package_id' is distinct from to_jsonb(q.package_id)
    or p_receipt->'quota_redeemed' is distinct from to_jsonb(q.expected_quota)
    or jsonb_typeof(p_receipt->'already_activated') is distinct from 'boolean' then raise exception 'allowance_receipt_mismatch';end if;
  if q.receipt is not null and q.receipt is distinct from p_receipt then raise exception 'allowance_receipt_conflict';end if;
  if q.state not in ('executing','uncertain','activated','review') then raise exception 'allowance_not_dispatched';end if;
  update apiwild_finance.supplier_allowance_outbox set receipt=p_receipt,
    state=case when state='review' then 'review' else 'activated' end,updated_at=clock_timestamp() where order_id=p_order returning * into q;
  return jsonb_build_object('activated',q.state='activated','review',q.state='review');
end;$$;

create function public.apiwild_allowance_claim(p_owner text,p_order uuid) returns jsonb
language sql security invoker set search_path='' as $$select apiwild_finance.allowance_operate('claim',p_owner,p_order);$$;
create function public.apiwild_allowance_dispatch_guard(p_owner text,p_order uuid,p_version bigint) returns jsonb
language sql security invoker set search_path='' as $$select apiwild_finance.allowance_operate('guard',p_owner,p_order,p_version);$$;
create function public.apiwild_allowance_finish(p_owner text,p_order uuid,p_version bigint,p_receipt jsonb) returns jsonb
language sql security invoker set search_path='' as $$select apiwild_finance.allowance_operate('finish',p_owner,p_order,p_version,p_receipt);$$;
create function public.apiwild_allowance_uncertain(p_owner text,p_order uuid,p_version bigint) returns jsonb
language sql security invoker set search_path='' as $$select apiwild_finance.allowance_operate('uncertain',p_owner,p_order,p_version);$$;

create function apiwild_finance.supplier_debit_apply(p_owner text,p_request uuid,p_fact jsonb,p_digest text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='5s' set statement_timeout='20s' as $$
declare r apiwild_finance.gateway_requests;b apiwild_finance.provider_budgets;old apiwild_finance.supplier_debit_receipts;result jsonb;cost bigint;
begin
  perform apiwild_finance.allowance_assert_server();
  if p_fact is null or jsonb_typeof(p_fact)<>'object' or octet_length(p_fact::text)>4096 or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
    or p_fact-'receipt_id'-'key_reference'-'upstream_response_id'-'model'-'currency'-'cost_cny_micros'<>'{}'::jsonb
    or jsonb_typeof(p_fact->'cost_cny_micros') is distinct from 'number' or (p_fact->>'cost_cny_micros') !~ '^[0-9]+$'
    or p_fact->>'currency' is distinct from 'CNY' or length(p_fact->>'receipt_id') not between 1 and 200
    or p_fact->>'receipt_id' ~ '[[:cntrl:][:space:]]' or p_fact->>'receipt_id' is null then raise exception 'supplier_invalid_receipt';end if;
  cost:=(p_fact->>'cost_cny_micros')::bigint;if cost not between 0 and 1000000000000 then raise exception 'supplier_invalid_cost';end if;
  r:=apiwild_finance.lock_request(p_owner,p_request);
  select * into b from apiwild_finance.provider_budgets where id=r.provider_budget_id;
  if p_fact->>'key_reference' is distinct from b.key_reference::text or p_fact->>'model' is distinct from r.model
    or r.settlement_reference is distinct from 'usage:'||(p_fact->>'upstream_response_id')
    or r.state not in ('succeeded','failed') then raise exception 'supplier_receipt_owner_mismatch';end if;
  select * into old from apiwild_finance.supplier_debit_receipts where request_id=p_request;
  if found then
    if old.user_id<>p_owner or old.fact<>p_fact or old.digest<>p_digest then raise exception 'supplier_receipt_conflict';end if;
    return jsonb_build_object('reconciled',old.reconciled,'replayed',true);
  end if;
  result:=public.apiwild_gateway_reconcile_supplier(p_owner,p_request,cost,'subrouter:'||(p_fact->>'receipt_id'));
  insert into apiwild_finance.supplier_debit_receipts(request_id,user_id,key_reference,receipt_id,fact,digest,reconciled)
    values(p_request,p_owner,b.key_reference,p_fact->>'receipt_id',p_fact,p_digest,(result->>'reconciled')::boolean);
  return result||jsonb_build_object('replayed',false);
end;$$;
create function public.apiwild_supplier_debit_apply(p_owner text,p_request uuid,p_fact jsonb,p_digest text) returns jsonb
language sql security invoker set search_path='' as $$select apiwild_finance.supplier_debit_apply(p_owner,p_request,p_fact,p_digest);$$;

revoke all on function apiwild_finance.allowance_assert_server(),apiwild_finance.allowance_sync(text,uuid),
 apiwild_finance.allowance_payment_changed(),apiwild_finance.allowance_operate(text,text,uuid,bigint,jsonb),
 apiwild_finance.supplier_debit_apply(text,uuid,jsonb,text),public.apiwild_allowance_claim(text,uuid),
 public.apiwild_allowance_dispatch_guard(text,uuid,bigint),public.apiwild_allowance_finish(text,uuid,bigint,jsonb),
 public.apiwild_allowance_uncertain(text,uuid,bigint),public.apiwild_supplier_debit_apply(text,uuid,jsonb,text)
 from public,anon,authenticated,service_role;
grant execute on function apiwild_finance.allowance_operate(text,text,uuid,bigint,jsonb),
 apiwild_finance.supplier_debit_apply(text,uuid,jsonb,text),public.apiwild_allowance_claim(text,uuid),
 public.apiwild_allowance_dispatch_guard(text,uuid,bigint),public.apiwild_allowance_finish(text,uuid,bigint,jsonb),
 public.apiwild_allowance_uncertain(text,uuid,bigint),public.apiwild_supplier_debit_apply(text,uuid,jsonb,text) to service_role;
commit;

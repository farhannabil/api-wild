-- Additive compatibility read for the existing AARO account page. No funding.
begin;
create or replace function public.aaro_billing_read_v1(p_owner text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
 perform aaro_finance.confirmed_owner_v1(p_owner);
 return jsonb_build_object('owner',p_owner,'frozen',coalesce((select frozen from aaro_finance.accounts where owner=p_owner),true),
 'bangladeshEligible',exists(select 1 from aaro_finance.region_evidence where owner=p_owner and accepted and expires_at>clock_timestamp()),
 'subscriptions',coalesce((select jsonb_agg(jsonb_build_object('plan',plan_reference,'status',status,'subscriptionId',id)) from aaro_finance.subscriptions where owner=p_owner),'[]'::jsonb),
 'creditPeriods',coalesce((select jsonb_agg(jsonb_build_object('invoiceId',invoice_id,'subscriptionId',subscription_id,'credits',credits,'spentCredits',spent_credits,'reservedCredits',reserved_credits,'remainingCredits',credits-spent_credits-reserved_credits,'periodStart',period_start,'periodEnd',period_end,'paid',paid,'frozen',frozen)) from aaro_finance.credit_periods where owner=p_owner),'[]'::jsonb));
end; $$;
revoke all on function public.aaro_billing_read_v1(text) from public,anon,authenticated;
grant execute on function public.aaro_billing_read_v1(text) to service_role;
commit;

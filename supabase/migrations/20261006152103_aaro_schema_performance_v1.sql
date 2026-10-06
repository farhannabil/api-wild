begin;
alter policy aaro_workspaces_select on public.aaro_workspaces
using ((select auth.uid()) = owner_id and product = 'aaro'
  and (select aaro_private.customer_is_confirmed_v1()));
create index aaro_accounts_customer_idx on aaro_finance.accounts(customer_id);
create index aaro_periods_owner_idx on aaro_finance.credit_periods(owner);
create index aaro_periods_subscription_idx on aaro_finance.credit_periods(subscription_id);
create index aaro_budgets_product_idx on aaro_finance.product_budgets(product);
create index aaro_requests_invoice_idx on aaro_finance.requests(invoice_id);
create index aaro_subscriptions_owner_idx on aaro_finance.subscriptions(owner);
commit;

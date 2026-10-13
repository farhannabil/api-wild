-- Apply after the analytics migration. Reusing job names updates schedules.
-- These jobs never change customer credits, quotas or canonical receipts.
create extension if not exists pg_cron;
select cron.schedule('apiwild-billing-audit-hourly','5 * * * *','select apiwild_finance.audit_customer_billing();');
select cron.schedule('apiwild-usage-dashboard-hourly','7 * * * *','select apiwild_finance.refresh_usage_dashboard();');
select apiwild_finance.audit_customer_billing() as billing_check;
select apiwild_finance.refresh_usage_dashboard() as dashboard_refresh;
select jobid,jobname,schedule,active from cron.job where jobname in ('apiwild-billing-audit-hourly','apiwild-usage-dashboard-hourly');

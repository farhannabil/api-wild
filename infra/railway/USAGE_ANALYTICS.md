# Hourly billing checks and customer usage

The existing native worker remains the only native credit importer. It imports verified supplier receipts about every five minutes and deducts actual supplier USD times five. New analytics metadata is stored separately, keyed to the same immutable receipt under the existing sync lease. Analytics failures do not block financial reconciliation; later passes retry enrichment.

Two Supabase pg_cron jobs run independently of Railway and of any desktop session:

- `apiwild-billing-audit-hourly`: minute 5 of every UTC hour. Checks settled cost5 charges/zero fees, pending reconciliation older than two hours, and active native keys not synced for 75 minutes. Records findings without modifying money or key allowances.
- `apiwild-usage-dashboard-hourly`: minute 7 of every UTC hour. Atomically rebuilds owner/day/model projections from canonical requests. Rebuilds replace prior values, including late settlements and cancellations, so retries do not inflate totals.

Install the migration first, then run `usage-analytics-cron.sql`. Stable job names update an existing schedule rather than duplicating it. Both jobs use transaction advisory locks, bounded statement timeouts, private RLS tables and fixed internal functions. Inspect actual scheduler execution in `cron.job_run_details`; the private `usage_job_status` table records successful checks/refreshes. No secrets are stored in cron commands.

The authenticated `/api/usage/details` endpoint derives the owner from the verified session, rejects caller-supplied identity parameters and returns only that owner's 30-day UTC data. Charts show real reported input/output/cache tokens, customer settled USD, model totals, missing cache coverage and sync times. The wallet remains the live financial source; hourly chart snapshots can lag it. Source import and chart refresh run on separate hourly schedules.

Cache counts are supplementary categories and may overlap reported input. They are never added to invent a total, multiplied by five, or priced separately. Native `other.cache_tokens`, cache creation total (or both 5m/1h components) and optional gateway usage details are preserved when valid; absent or invalid counts are unknown. Historical cache data is not fabricated. Historical charges retain their original policy.

Validation: isolated PostgreSQL tests cover owner separation, denied customer-role access, immutable financial facts, zero versus unknown cache, duplicates/conflicts, late settlement/cancellation and audit alerts. The $1 supplier receipt yields a $5 chart charge and leaves $20 of a $25 wallet. These fixtures do not constitute a paid customer inference test.

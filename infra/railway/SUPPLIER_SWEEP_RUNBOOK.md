# Bounded background supplier reconciliation

- The existing Railway preparation server can run the reviewed receipt reconciler in the background. There is no new service, cron, public endpoint, customer charge or model call.
- Deployment requires both reviewed migrations in order: `20261005103212_supplier_receipt_reader.sql`, then `20261005104158_supplier_pending_list.sql`. Root applies them; source tests do not apply production SQL.
- Configure the receipt runbook's secret environment and trusted bindings/conversion, plus `APIWILD_BILLING_MODE=live` or `test` for that service. Enable only with **both** `APIWILD_SUPPLIER_DEBIT_ENABLED=true` and `APIWILD_SUPPLIER_SWEEP_ENABLED=true`. Neither defaults to enabled. `--local` preview never starts the worker.
- The service-only list returns at most five finalized, supplier-pending requests belonging to the configured mode and key references, with exact persisted same-response request UUIDs. It returns owner/request/cursor identity only. The database list is read-only and has no new table or ledger mutation.
- One pass runs at a time. Each candidate gets the already reviewed, bounded receipt check; only an authoritative matching receipt reaches the idempotent apply RPC. A missing or ambiguous receipt stays held, and the cursor advances so later candidates can be processed. A short/empty final page wraps the in-memory cursor.
- The next pass starts60 seconds **after** the prior pass completes. A batch may take up to five30-second reconciliations plus its bounded list call; no overlapping batch is started to catch up. SIGTERM/SIGINT abort transport, cancel timers and prevent another candidate from starting.
- Operational output contains attempted/reconciled/held counts only. `automaticRetry:false` refers to inference/payment operations: later passes may check a held receipt again, but never replay a model, payment or financial mutation without the same idempotent receipt authority.

## Limits and recovery

- Candidates are restricted to the current **UTC** day, and the supplier's documented default log window is its current day. The reader does not invent historical filters. A request outside either window remains held for an explicitly reviewed recovery operation.
- The rotating cursor is memory-only. Restarts begin at the first current-day candidate; repeated receipts remain protected by database identity/idempotency. Healthy long-lived operation rotates past failures; continuous restart is not a reliable backlog-recovery mechanism.
- The reader's maximum10 pages of20 supplier rows can make a busy account's current-day log unscannable. Such requests remain held; verified server-side receipt filtering or a larger separately reviewed bound is needed before increasing traffic beyond that operating envelope.
- A conversion change or expiry blocks both future dispatch and receipt reconciliation. The accepted snapshot is immutable for retries. Do not replace it merely to force pending historical debits through; investigate their original accounting basis.
- Supplier overruns retain the hold and freeze the provider budget. This worker does not clear a freeze or forgive a debit.

## Local checks

```powershell
node --test infra/railway/tests/supplier-debit-sweep.test.mjs infra/railway/preparation.test.mjs
node infra/railway/tests/supplier-pending-list-postgres.mjs C:/Users/farha/AppData/Local/Temp/apiwild-launch-pglite-20261005/node_modules/@electric-sql/pglite/dist/index.js
```

- Local fixtures verify non-overlap, five-item bounds, cursor progress past failure, shutdown, mode/key scoping, precise cursor retention, denied customer access and absence of database mutations during list reads.
- They do not certify live scheduling, real provider receipt delivery or independent-connection concurrency. Observe the real deployment and one genuine customer receipt separately.

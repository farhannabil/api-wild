# Supplier wallet debit reconciliation

- This reads an actual finalized Subrouter wallet debit from the authorized account log. Its native amount is integer USD quota, **not a native CNY API field** and not a token-cost estimate.
- At the accepted public settings, 500000 quota = USD1 and USD1 = CNY6.8. Four quota normalize to CNY0.0000544; the held supplier budget records the conservative ceiling of **55 CNY micros**.
- The original quota, log/account/token/provider identity, published conversion fields, accepted snapshot timestamp/expiry and SHA256 remain in the immutable private receipt fact. PostgreSQL independently checks exact decimal arithmetic and the settings hash.
- The customer retail USD charge is separate. This operator does not fund a customer, alter a retail charge, dispatch a model, activate native SaaS, create credentials or retry an inference request.

## Prerequisites

1. Independently review and deploy `20261005103212_supplier_receipt_reader.sql`. It adds the service-only identity reader, validates optional native audit on receipt apply and permits up to39 models in one existing shared budget. It does not accept/fund/create any budget.
2. Configure only in the secret runtime environment: `SUPABASE_SECRET_KEY`, `SUBROUTER_ACCOUNT_ACCESS_TOKEN`, `SUBROUTER_ACCOUNT_USER_ID`, `APIWILD_SUPPLIER_BINDINGS_JSON`, `APIWILD_SUPPLIER_CONVERSION_JSON`. Account OAuth is separate from an inference key.
3. Bind each trusted opaque UUID key reference to its exact supplier token ID and approved per-model provider slug. At most two key references and39 models per binding are accepted. Example shape, using synthetic values only:

```json
{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":{"tokenId":123,"modelProviders":{"MiniMax-M2.7-highspeed":"leapnode"}}}
```

4. Generate the accepted conversion with exported `pinSupplierConversion({status,observedAt,validUntil})` from the exact public `/api/status` data. Both `price` and `usd_exchange_rate` must match; quota denomination must be500000, display currency CNY and `display_in_currency=true`. Set an explicit expiry no later than30 days. Keep this exact config stable across retries. Never substitute a current timestamp when replaying a fact.
5. Inference-enabled assembly also requires this config and checks public conversion before every actual dispatch. Missing/expired/drifted settings prevent paid dispatch. A clock/settings check cannot lock upstream FX across an in-flight request; any subsequently observed drift keeps reconciliation held.
6. The database request must already be a final `succeeded` or `failed` row with `supplier_pending=true`, the exact owner, and the same-response `providerRequestId` recorded in private usage and settlement reference. UUID is the default contract. The separately reviewed bangai migration permits exactly eight lowercase hexadecimal characters only for its four named approved models, with bangai retained in immutable private usage and matching the native receipt provider. An unrelated direct supplier test has no eligible customer request and cannot be retroactively treated as customer acceptance.

## One explicit request

1. Check local configuration only; no network or database calls occur:

```powershell
node infra/railway/supplier-debit.mjs --check --owner test:supabase:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --request bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

2. After approval/configuration, set `APIWILD_SUPPLIER_DEBIT_ENABLED=true` in the private operator environment. Run the same exact owner/request with `--execute`. Do not put credentials, debit values or supplier receipt fields on the command line.
3. Success is `reconciled:true,held:false,automaticRetry:false`. Failure or uncertainty is held; investigate it without replaying paid work or releasing an ambiguous hold. The compact output has no customer content, secrets or supplier receipt IDs.

## Actual boundaries

- Only GET `/api/status` and documented GET `/api/log/self?cursor=...&page_size=20` are used upstream. The latter defaults to the supplier's current day. Historical filter parameter names have not been verified, so this implementation does not invent them.
- At most10 pages of20 rows,262144 bytes per response and one finite deadline. Every page must finish; duplicate matches, cursor loops, unknown wallet/source/provider/key/model, fractional quota and changed settings fail closed.
- Public settings are checked before and after reading the log. The same accepted snapshot produces a stable fact/digest. Once a request is reconciled, the private pending reader returns null; a repeated one-request operation does not create another debit.
- The separately enabled production supplier sweep uses this reader. Older/out-of-window receipts remain held for an explicitly reviewed recovery path; see `SUPPLIER_SWEEP_RUNBOOK.md`.

## Verification

```powershell
node --test infra/railway/tests/subrouter-receipt-reader.test.mjs infra/railway/tests/supplier-allowance.test.mjs infra/railway/tests/deepseek-assembly.test.mjs infra/railway/tests/owned-gateway-assembly.test.mjs infra/railway/tests/owned-discovery-http.test.mjs
node infra/railway/tests/supplier-receipt-postgres.mjs C:/Users/farha/AppData/Local/Temp/apiwild-launch-pglite-20261005/node_modules/@electric-sql/pglite/dist/index.js
```

- SQL uses isolated PGlite0.5.8 only; it is not proof of live receipt delivery, independent-connection contention or customer end-to-end success.
- Contract sources: official Subrouter account skill (`/api/log/self`, account headers and USD quota denomination), authorized read-only `/api/status` and `/api/log/self` response shapes verified2026-10-05, [Supabase database functions](https://supabase.com/docs/guides/database/functions), [Supabase migration CLI](https://supabase.com/docs/reference/cli/supabase-migration-new).

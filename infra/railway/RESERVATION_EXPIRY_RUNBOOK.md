# One-request reservation cleanup

- This nonpublic operator uses the service-role-only `apiwild_gateway_expire(text, uuid, bigint)` RPC. The production server can also run the bounded expiry worker after the reviewed `20261005121036_reservation_expiry_sweep.sql` migration and explicit enablement.
- The database alone checks the exact owner, request, current version, state and expiry under its existing locks. Only expired `reserved` work can become `cancelled`. `executing`, `uncertain` and settled supplier-pending requests are never released by this RPC.
- Execution is disabled unless `APIWILD_RESERVATION_EXPIRY_ENABLED=true` is supplied in the trusted server environment. `SUPABASE_SECRET_KEY` must belong to the original API WILD Supabase project. Do not put credentials in commands, repository files or logs.

1. Obtain one verified owner, request UUID and current version from the authorized operations lane. Do not guess these values or list customer requests through this operator.
2. Run the local configuration check, replacing the placeholders:

   ```powershell
   node infra/railway/reservation-expiry.mjs --check --owner MODE:supabase:CUSTOMER_UUID --request REQUEST_UUID --version VERSION
   ```

   This performs zero network requests and does not certify database state.
3. With the explicit execution gate configured in the trusted environment, run once for that same reference:

   ```powershell
   node infra/railway/reservation-expiry.mjs --execute --owner MODE:supabase:CUSTOMER_UUID --request REQUEST_UUID --version VERSION
   ```

- Exit 0 means confirmed cancellation (or successful local check). Exit 2 means unchanged/held. Exit 3 means disabled, invalid configuration or unconfirmed outcome. An unconfirmed response may follow a committed database operation: investigate the exact record through the owner lane before another manual attempt. There is no automatic retry.
- The operator sends exactly one bounded request to the fixed original Supabase RPC. Output contains only a disposition, never request results, account references, supplier receipt content or credentials.
- Supplier-pending liabilities use the separate actual wallet-debit reader. Native USD quota is conservatively normalized into CNY using the audited, pinned supplier settings. Estimates cannot clear those holds; reservation expiry never substitutes for supplier reconciliation.

## Bounded production worker

- `APIWILD_RESERVATION_EXPIRY_ENABLED=true` enables a single-flight pass after startup and then every60 seconds after completion. Local preview never starts it.
- Each pass selects at most5 expired pristine reservations in the configured billing mode and supplier key references. The cancellation RPC rechecks version, state, expiry and all financial/response evidence under locks.
- Supplier-pending, executing, uncertain, overrun or already-settled requests remain unchanged. Shutdown aborts current network work and prevents another candidate from starting.

## Local checks

```powershell
node --test infra/railway/tests/reservation-expiry-operator.test.mjs
node infra/railway/tests/reservation-expiry-postgres.mjs 'C:/Users/farha/AppData/Local/Temp/apiwild-launch-pglite-20261005/node_modules/@electric-sql/pglite/dist/index.js'
```

- Tests use synthetic identities and isolated PGlite 0.5.8 outside the repository. They verify the actual existing SQL RPC, including stale versions, foreign owners, public-role denial and unchanged ambiguous holds. They do not certify independent-connection concurrency or live supplier debit acceptance.

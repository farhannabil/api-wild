# One-request reservation cleanup

- This nonpublic operator uses the existing service-role-only `apiwild_gateway_expire(text, uuid, bigint)` RPC. No migration, scheduler, customer enumeration or supplier endpoint is added.
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
- **Separate remaining acceptance gate:** supplier-pending liabilities still need an authoritative actual-CNY receipt reader linked to the exact credential, upstream response and model. Token counts, quota units, estimated prices and logs lacking a final debit amount cannot clear those holds. This cleanup operator does not make supplier reconciliation or product launch ready.

## Local checks

```powershell
node --test infra/railway/tests/reservation-expiry-operator.test.mjs
node infra/railway/tests/reservation-expiry-postgres.mjs 'C:/Users/farha/AppData/Local/Temp/apiwild-launch-pglite-20261005/node_modules/@electric-sql/pglite/dist/index.js'
```

- Tests use synthetic identities and isolated PGlite 0.5.8 outside the repository. They verify the actual existing SQL RPC, including stale versions, foreign owners, public-role denial and unchanged ambiguous holds. They do not certify independent-connection concurrency or live supplier debit acceptance.

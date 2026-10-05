# Supplier allowance operator — October 5, 2026

- Source is implemented and locally tested. Production application, native grants and real supplier reconciliation are **not verified**.
- This is one explicit order operation, not a scheduler or a public payment endpoint. Importing the modules makes no calls.
- Keep customer checkout/inference activation closed until the actual supplier mapping, constraints, payment, native allowance and model/debit acceptance pass.

## Required accepted inputs

1. Original Supabase project `yautmilnpllojugpmfgy`, correct account access, existing finance migrations and the new reviewed migration `supabase/migrations/20261005083727_supplier_allowance_outbox.sql` applied and independently checked. CLI version `2.119.0` created the filename. Source generation did not apply it. Do not blanket-push earlier migrations over differing production history.
2. A canonical Stripe-paid API WILD order already projected into its owner’s USD ledger. The SQL reads the registered order and exact positive checkout entry; the operator cannot supply a paid flag or change credit.
3. A reviewed, accepted row in private `supplier_allowance_mapping` for that exact order and owner: native user ID, package ID, paid credit cents, exact native quota, policy SHA-256, opaque redemption-code reference and code SHA-256. There is no inferred quota/USD conversion or fixed wholesale allowance. Only the privileged configuration lane can write mappings.
4. Proof that the selected inference credential spends the allowance of **that same native user**. A successful native package activation alone does not prove that an existing shared supplier token enforces customer quota. Credentials, routing and budgets remain a separate gate.
5. Fresh activation token and the exact corresponding redemption code delivered through the approved server secret mechanism. Never put either in a CLI argument, shell history, source, tickets, logs or chat.
6. An authoritative supplier accounting reader that returns an immutable request-linked **actual CNY debit**. Current `supplier-debit-reconciliation.mjs` deliberately provides only an injected reader contract. No documented debit API/conversion adapter has been supplied. This gate remains blocked; token estimates and station quota cannot be used as actual supplier charges.

## Local verification

- Node runtime tests use fixtures only:

```powershell
node --test infra/railway/tests/supplier-allowance.test.mjs infra/railway/tests/supplier-allowance-operator.test.mjs
```

- SQL tests execute the generated migration and original Stripe projector inside in-memory PostgreSQL. Supply an isolated pinned `@electric-sql/pglite@0.5.8` module path:

```powershell
node infra/railway/tests/supplier-allowance-postgres.mjs ABSOLUTE_PATH_TO_PGLITE_DIST_INDEX_JS
```

- This validates SQL state transitions and repeated claim admission. PGlite shares one connection; the parallel Promise calls are not proof of competing independent Postgres transactions. Complete independent-connection concurrency acceptance before commercial activation.

## One approved order operation

1. Use an isolated operator process with these injected environment names: `SUPABASE_SECRET_KEY`, `SUBROUTER_SAAS_ACTIVATION_TOKEN`, `APIWILD_NATIVE_CODE_REFERENCE`, `APIWILD_NATIVE_REDEMPTION_CODE`. The last reference must match the accepted private SQL mapping; its code must match the stored SHA-256.
2. Run the local check. Replace the placeholders with the **exact** verified owner and order. It makes zero network requests and does not prove database, package or mapping acceptance:

```powershell
node infra/railway/allowance-worker.mjs --check --owner MODE:supabase:CUSTOMER_UUID --order ORDER_UUID
```

3. Only in the approved bounded operator process, inject `APIWILD_ALLOWANCE_WORKER_ENABLED=true`. Do not add a repeating job. Execute that one order:

```powershell
node infra/railway/allowance-worker.mjs --execute --owner MODE:supabase:CUSTOMER_UUID --order ORDER_UUID
```

4. The output contains only disposition, never codes or credentials. Exit `0` with `activated:true` means the exact native receipt was stored. Exit `2` means held for reconciliation. Exit `3` means disabled, missing/invalid configuration or an invalid operation. A local `--check` also exits `0`; do not confuse it with activation.
5. Remove the one-order secret injection after the operation. Record the nonsecret order/source/deployment/database receipts through the normal evidence lane.

## Replay, refund and uncertainty

- Signed payment projection durably enqueues the order in the same SQL transaction. Missing mapping remains `awaiting_mapping`; no grant is dispatched.
- Claiming changes the outbox to `executing` once. Duplicates and uncertain outcomes never dispatch automatically, even though the supplier contract itself supports the same `order_id` idempotency.
- A final pre-dispatch check re-reads payment/refund/dispute/mapping state. After an ambiguous request, preserve the claim and investigate the exact existing native order. Never switch to a new order ID, code or customer to force a retry.
- Refund/dispute before dispatch blocks the grant. After a possible grant, it marks `review` and suspends the API WILD account. The system **does not claim to revoke upstream quota**; no native reversal API is verified. Keep the customer’s direct upstream access disabled until the native quota/credential state is reconciled.
- `supplier_debit_apply` binds actual accounting to customer, request, model, credential reference and upstream response. Receipt identity cannot be reused across requests. An over-reserve amount retains the hold and disables that provider budget.
- No automatic un-suspension, quota revocation, ambiguous activation replay or wholesale adjustment is implemented. Those operations need verified native authority and an independently reviewed closing receipt.

## Documentation basis

- [Supabase database functions](https://supabase.com/docs/guides/database/functions): private privileged implementations, empty search paths and explicit execute grants.
- [Supabase row security](https://supabase.com/docs/guides/database/postgres/row-level-security): RLS plus revoked client/table grants. Service-role credentials remain server-only.
- Current [Supabase changelog](https://supabase.com/changelog) checked October 5. No new extension, encrypted data type, custom operator or provider feature was added.

# Bounded sandbox acceptance

This local operator harness is excluded from the production image. Its tests use synthetic fixtures and do not prove a real payment, database write or supplier debit. Running `--check` only validates configuration without network requests. Starting `--serve` requires a separately approved execution window; commands can create real **sandbox** Stripe records and spend the separately approved supplier test budget.

## Fixed scope

- Confirmed customer: `71ced254-af80-44db-8667-124ef995f095`, ledger owner `test:supabase:71ced254-af80-44db-8667-124ef995f095`.
- Stripe sandbox: `acct_1UCiHk0SGcPsf6AA`; existing USD1 one-time price `price_1UN3Cg0SGcPsf6AA2ORSh8l6`, quantity30. No live Stripe operation.
- Supplier test budget: `66830e89-712b-4dba-9f20-750746039d9c`; key reference `fb051542-0272-489a-b43e-b4c0f85fd57a`; old restricted token113333; only `MiniMax-M2.7-highspeed` from `leapnode`.
- One new model attempt, output limit128, input limits at most512, supplier reservation at most10000CNYmicros. Root separately verifies the real budget row and remaining native quota. No top-up or route fallback.
- The real CLI account/price and canonical payment checks stay enabled. A harness-only marker allows injection of the CLI transport; it is intercepted before HTTP. This proves the canonical financial projection using CLI sandbox authority, **not** acceptance of a production HTTP Stripe API key.

## Configuration and preflight

Provide secrets through the process environment using the approved secure source. Do not print them, put them in command arguments, or read browser storage.

Required variables:

- `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` for the original project.
- `APIWILD_SANDBOX_RUN_ID`: one fresh UUID; `APIWILD_SANDBOX_RUN_STATE_PATH`: an absolute, nonexistent file outside the repository named `apiwild-sandbox-<run>.jsonl`. The parent directory must already exist. The harness exclusively creates and synchronously checkpoints this file. Never delete/reuse it to repeat an uncertain attempt.
- `APIWILD_SANDBOX_PRICE_ID`, `APIWILD_SANDBOX_ROUTE_JSON`, `APIWILD_SANDBOX_RETAIL_RATE_VERSION=apiwild-launch-20261005`.
- `APIWILD_SANDBOX_UPSTREAM_KEY`: the approved old restricted test key.
- `APIWILD_SUPPLIER_CONVERSION_JSON`: the reviewed settings snapshot with its valid window and digest.
- `SUBROUTER_ACCOUNT_ACCESS_TOKEN`, `SUBROUTER_ACCOUNT_USER_ID`: the approved account log read authority.
- `APIWILD_SANDBOX_E2E_ENABLED=true` only for the approved run.
- Optional `APIWILD_STRIPE_CLI_PATH`: exact installed native Stripe executable. Default points to the already installed Windows Stripe CLI. It uses the existing default sandbox CLI authorization; do not switch profiles during a run.

The reviewed receipt migration and accepted test provider budget must already exist in Supabase. The real customer must have confirmed email and completed onboarding. The harness initializes a mode-separated account and issues/revokes its own short-lived `aw_test` key through the real service RPCs; it does not mint customer JWTs or insert customer credit.

1. Run `node infra/railway/sandbox-e2e.mjs --check` and inspect the nonsecret result. This does not verify remote credentials or accounting.
2. After independent review and execution approval, run `node infra/railway/sandbox-e2e.mjs --serve` in a controllable foreground terminal. The server binds only `127.0.0.1`, creates a fresh private gateway transport nonce, and starts a genuine sandbox Stripe listener. Its signing secret remains in memory and is never displayed.
3. Enter `create-checkout` once. Open the displayed local URL, then its registered Stripe Checkout link. Complete that exact hosted sandbox checkout using Stripe's documented test card flow. Do not create an unrelated PaymentIntent or trigger a fabricated event. No customer email is supplied by this harness.
4. Enter `payment-status` until it reports the registered order paid and exactly USD30 of additional credit. These are read-only checks. The genuine signed webhook and canonical account/session/PaymentIntent read must already have projected the credit.
5. Enter `run-model` once. Record request ID, actual content acceptance flag, tokens and retail debit. `responseReceived:false` means empty output and is not acceptance. Failed or interrupted attempts remain single-use; inspect `status` and the durable checkpoint for the reserved request ID. Never issue another model request to repair an uncertain result.
6. After a successful completion, enter `replay` once. It must return the exact same settled completion and unchanged ledger usage; it must not perform a second supplier dispatch.
7. Enter `reconcile` once after the supplier charge log is available. The exact persisted request UUID, token, model, supplier and wallet debit must match, with pinned USD-quota normalization and both conversion checks. A missing/ambiguous/late receipt remains held. Use a separately reviewed exact-request operator for later recovery; do not repeat paid inference.
8. Enter `refund` once after reconciliation. The harness revokes its test key first, then requests the genuine full sandbox refund of the same PaymentIntent. Enter `refund-status` to verify the signed reversal and order status. A full refund after consuming test credit may suspend this test wallet; if the customer-scoped usage RPC rejects that state, the report explicitly returns unknown for the funded balance and root must verify the final ledger through its authorized SQL session.
9. Enter `close` to revoke any remaining test key and stop the listener/server. EOF or the30minute window also closes the session. Exit0 only means the harness closed; it is not an end-to-end acceptance certificate.

## Evidence and failure handling

Keep the checkpoint file and real Stripe event/order/payment/refund IDs, gateway request/key IDs, exact supplier receipt, before/after ledger and final key-revocation readback. Checkpoints contain no raw API keys, webhook secret or customer content. A crashed process cannot clean up its key automatically; the30minute expiry bounds it, and root can revoke the recorded key/request through the existing authorized service path. The key ID is available in the actual database; the harness never exports its raw key.

Each mutating phase records `attempted` before work and rejects a second attempt in that process. Starting a new run is a separate operator decision and cannot be used to replay uncertain work. The harness does not fake financial facts, bypass account/mode checks, perform autonomous retries, or mark production launch ready.

Official references: [Stripe testing](https://docs.stripe.com/testing), [Stripe CLI listener](https://docs.stripe.com/cli/listen).

# AARO owned backend integration — October 6, 2026

- Owner: Farhan. Tracking: GEN-10. The consumer product remains AARO; API WILD retains its enterprise USD wallet.
- Base source: verified API WILD production `f626aa67eb044e40223c24d8c574e555108d0131`. New code is a separate conditional AARO adapter in the existing Node backend. It performs no supplier calls or payment writes when its switches are absent.
- Existing AARO service: Railway project `631430de-ba93-42a4-8c5f-9c8a1cd0738d`, staging service `8c7d6903-548c-46c2-9db0-4e18b0823ce0`; private `farhannabil/aaro` main. GitHub source/branch/Wait for CI are now linked. AARO PR1 source `9a862268ea93b457b977bf95b0695e33f4cffcf3` deployed successfully as `2ecf738f-1a66-40ed-aa58-7d9a89fafac1`. Web readiness is true; customer readiness remains false.
- AARO's original private Sites repository, Bangla/English UI and device history are preserved. No DNS cutover or paid hosting upgrade occurred.

## Installed database authority

- Original Supabase project `yautmilnpllojugpmfgy`, PostgreSQL17.6. Five additive AARO migrations install owner-only cloud workspace CAS, isolated usage accounting, missing indexes, original Stripe subscription bindings and the account compatibility read.
- `aaro_finance` has14 private tables; `aaro_private` holds cloud helpers. Actual Data API requests with either private schema return406/PGRST106. Anonymous/authenticated/service roles have no direct finance table access. Twelve finance RPCs are service-only; authenticated cloud save/read are separately owner constrained.
- Fresh readback: zero AARO accounts, periods, customers, orders, events, holds, accepted region evidence, tariffs, budgets or cloud workspaces. No seed credits, legacy D1 import, fake acceptance or device migration.
- API WILD table fingerprint remains `9bd7a0aff1cfd5eb71c16cd5cb3c4bfd`; function fingerprint remains `f7b8791cf74b54db6a313df199e29848`. Auth user count remains5. These prove the compared definitions/count; they do not claim a full provider backup. Source/preflight/receipts are preserved locally.
- New AARO performance findings were corrected. Private finance RLS with no client policies is intentional denial by default. Existing unrelated Auth/password and RLS warnings remain outside this change.
- Migration files record the exact applied bodies and remote versions. Do not reapply them manually.

## New backend behavior

- `/api/aaro/billing`, `/api/aaro/checkout`, `/api/aaro/portal`, `/api/aaro/webhook` are separate from API WILD billing. Confirmed Supabase identity becomes `MODE:supabase:UUID`; caller metadata never selects ownership.
- Checkout resolves an AARO-only original-merchant customer, verifies the original active monthly Price/Product, registers a frozen owner order, and uses one fixed Stripe idempotency key. Expired/ambiguous intents cannot create a fresh replacement order automatically. Portal and checkout return to `https://aaroglobal.com/account`.
- Raw signed events are authenticated before JSON parsing. Canonical original-account Subscription → Invoice → InvoicePayment → PaymentIntent/Charge/refund records precede service-only projection. Checkout completion never funds credits. Complete bounded native lists, exact customer/currency/amount/monthly plan and current regional evidence are required.
- Paid periods grant fixed AARO units once. Duplicate invoices preserve spent/reserved units; overlapping periods are rejected. Refund/dispute/fraud holds remain sticky. Terminal subscriptions cannot be resurrected by delayed invoices. No browser success, manual seed or API WILD USD funding grants AARO units.
- Account compatibility returns original plan names, trusted Bangladesh eligibility, and current usable credit totals only after accepted provider/finance gates and an active matching subscription. Display currency is not eligibility.
- `/api/aaro/usage` uses the existing reviewed reserve → claim → one dispatch → settlement/uncertain protocol. Its new supplier oracle independently matches the dedicated native key/token/model, header request ID, log token counts, wallet charge and conversion. Unknown/mismatched receipts retain liability; no paid replay.
- Runtime assembly rejects known API WILD key UUIDs and supplier token IDs. AARO's proposed ¥50 total/no-top-up policy is not actual provisioning or measured economics. No dedicated provider key, tariff or acceptance was created here.
- The container includes all new conditional modules and the original AARO catalog; no SQL applies automatically at startup.

## Secure activation inputs — names only

- Existing API WILD backend owns Supabase/Stripe credentials. They stay there. AARO's frontend service must never receive Supabase privileged or original merchant secret keys.
- API WILD backend: `AARO_BILLING_ENABLED`, `AARO_BILLING_MODE`, dedicated `AARO_STRIPE_WEBHOOK_SECRET`, and later `AARO_CHECKOUT_ENABLED`.
- Usage assembly: `AARO_FINANCE_ENABLED`, `AARO_BRIDGE_KEY`, `AARO_SUBROUTER_MANIFEST`, `AARO_SUPPLIER_BINDING_JSON`, `AARO_SUPPLIER_CONVERSION_JSON`, dedicated `AARO_SUBROUTER_ACCOUNT_ACCESS_TOKEN`.
- Existing AARO Railway service: dedicated `AARO_SUBROUTER_API_KEY`, `APIWILD_BRIDGE_KEY` with the same private bridge value, and reviewed `AARO_SUBROUTER_MANIFEST`. Provider credentials must come from the AARO-only allowance, never the enterprise/coding key.
- `AARO_FINANCIAL_ACCEPTANCE_VERIFIED`, `AARO_PROVIDER_ACCEPTANCE_VERIFIED`, `AARO_WEBHOOK_INGRESS_VERIFIED` remain unaccepted until genuine tests. Credentials alone do not justify those flags.
- Original live Stripe merchant is `acct_1UCiHN194XZKj6cF`. AARO's seven existing catalog products were read active; detailed global prices and Bangladesh Max were reverified. Remaining canonical details must be read before activation. Original live price IDs are not a verified sandbox catalog.
- No merchant legal/tax configuration changed. Stripe Tax registrations remain unverified; automatic tax was not enabled.

## Validation and remaining acceptance

- Local backend regression:174 passing tests. Shared real isolated PostgreSQL18 fixtures:12 passing funding/concurrency/hold/grant checks; retained clusters are stopped. Earlier source/fixture failures and their logs remain preserved. AARO cloud regression:13 passing checks. These are fixtures, not real customer/payment/provider acceptance.
- A dedicated GitHub workflow runs the same funding/concurrency tests on disposable PostgreSQL17 plus the conditional adapters. Existing application/container CI remains required before release.
- Still required: dedicated AARO supplier/key/budget provisioning; original merchant AARO webhook signing secret; verified prices and sandbox mapping; accepted model tariff/conversion/native receipt; a separately authorized finite real model call and genuine signed invoice; real AARO signup/confirmation/recovery/cloud persistence; domain/TLS/callback verification before cutover.
- No payment, refund, inference, top-up or automatic acceptance was performed in this continuation. Hosted voice/computer/other unconnected features remain unavailable.

## Rollback

- Disable AARO checkout/billing/finance/provider flags and revoke only AARO RPC grants if isolation is needed. Retain all AARO/customer/supplier records for reconciliation; do not drop schemas or reset spending.
- API WILD previous exact runtime is `f626aa67eb044e40223c24d8c574e555108d0131`; AARO retains previous CLI deployment `55283516-995d-441f-a035-76d9f772a4d1` and GitHub deployment history.
- Preserve both source checkouts, native receipts, original Sites remote, existing domain nameservers and all uncertain holds.

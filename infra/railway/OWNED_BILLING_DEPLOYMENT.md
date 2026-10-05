# API WILD owned prepaid billing

Subrouter is upstream supply only. This path does not modify its station.

Assembly: await `createOwnedBillingFromEnv(process.env)` once, dispatch its `matches(request.url)` routes to `handle(request,response)` before frontend/native dispatch. Do not mount two handlers for `/api/billing/webhook`.

Environment:
- `OWN_BILLING_ENABLED=true` permits owned account reads with a Supabase service credential.
- `BILLING_MODE=live` (or test, exact existing Stripe account is fixed by mode).
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, optional `SUPABASE_ANON_KEY`.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CREDIT_PRICE_ID` are all required for checkout and webhook activation. Missing payment secrets leave reads available and checkout disabled.
- Existing live USD1 one-time price: `price_1UN10k194XZKj6cFzuuvwE8T`.
- Stripe SDK22.6.0 default API version verified from installed SDK metadata: 2026-08-26.dahlia. No implicit SDK retries; 15s request deadline.

Migrations, after existing gateway portability migration:
1. 20261005010000_apiwild_stripe_projection.sql
2. 20261005010100_apiwild_stripe_checkout.sql
3. Gateway owner's additive migration providing apiwild_gateway_account_initialize.

Authenticated endpoints use confirmed nonanonymous Supabase users. API billing reads initialize their zero-credit account idempotently. Checkout accepts only `{amountCents,requestId}` with a UUID request ID. The same request ID must survive ambiguous retries. USD30 minimum, whole-dollar amounts because the unit Price is USD1; USD1,000,000 upper limit is the existing financial ledger's exact integer amount ceiling, not a pricing package decision. No $250 business cap remains.

GET `/api/billing`: `{balanceCents,orders,checkoutEnabled,minimumTopupCents}`.
POST `/api/billing/checkout`: returns `{url,orderId,creditsGranted:false}` only after session registration.
GET `/api/billing/reconcile?sessionId=...`: reads owned recorded status; never grants credits from returning to a URL.
POST `/api/billing/webhook`: signature verification, canonical Stripe reads and exact-account financial projection. Existing paid-event, refund and dispute handlers are reused.

Stripe customer mapping is durable and service-only. Stripe sessions reference the persisted owner/order; events cannot create arbitrary credit orders. A webhook racing session registration fails retryably; checkout URL is withheld until registration succeeds. The checkout request itself never grants credits.

No live charge or inference acceptance has occurred. Local PGlite validates both migrations over gateway schema, duplicate credit events, partial refunds, durable customer mapping and anonymous privilege denial. Production schema and credentials must be verified separately.

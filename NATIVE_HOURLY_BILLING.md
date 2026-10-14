# Native customer keys and hourly retail billing — 2026-10-12 (updated 2026-10-14: white-label + hard X/5 budget)

API WILD keeps its existing Stripe-funded USD wallet. New customer keys are individually issued by the supplier but served through API WILD's white-label relay at https://apiwild.com/v1 — the supplier origin is never shown to customers.

Receipts are uniquely bound by account/log ID and exact token ID; repeat imports do not charge twice, and changed receipts fail closed. The worker pauses a token with the provider status-only endpoint, imports complete logs, checks cumulative used quota, releases the previous hold, and funds the token with the customer's entire available balance divided by 5 as a hard supplier budget. Revoke and sync share a database lease. The supplier-side quota is a hard guardrail: the supplier stops the token at quota zero, so a customer cannot overrun their funded balance. Reconciliation remains hourly. No credit transfer into a native distributor customer account is required.

Validation: 519 runtime tests passed (two PostgreSQL harness entrypoints require their separate CI invocation); TypeScript passed; Railway production build passed; PGlite billing integration passed. The same SQL fixture passed against production inside a transaction that rolled back. Production migrations 20261012234347 and 20261013003000 applied successfully. Live zero-quota provider test created a dedicated sk key, verified customer binding, then revoked it: supplier usage zero, owner wallet unchanged. No paid native request or hourly paid customer acceptance is claimed.

Release starts from main 762915277efb1e345d023b64b1cc8346949f8958. Feature flags: APIWILD_NATIVE_CUSTOMER_KEYS_ENABLED=true and APIWILD_NATIVE_KEYS_AUTHORIZATION_EXPIRES_AT=2026-11-04T10:25:19Z. Existing upstream spending budget and deadline remain in force. Existing aw_live gateway keys remain compatible with apiwild.com/v1.

Production release SHA and Railway deployment evidence will be recorded after deployment. Owner: Farhan; tracker: GEN-10. Repository: farhannabil/api-wild; site/service: apiwild.com / Railway af8ce804-b94b-4721-a858-0253d8eeabb2.

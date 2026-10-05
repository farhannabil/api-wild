# Native customer flow activation

The BFF uses a native station customer session for account, key, usage and billing actions. Supabase remains a separate existing CRM/customer identity; there is no email-based mapping or automatic transfer of Supabase credits into native quota.

Configure exactly one replica. Native sessions are private process memory and expire on restart. All flags default false:

- `NATIVE_AUTH_ENABLED`: native login/register/session.
- `NATIVE_CUSTOMER_ENABLED`: native account/usage/key metadata and billing reads.
- `NATIVE_KEY_WRITES_ENABLED`: customer-confirmed key creation/revocation.
- `NATIVE_CHECKOUT_ENABLED`: native Stripe checkout. Native station top-up info must independently confirm configured USD Stripe and exchange rate 1. Backend owns native quota credit; return-page navigation grants nothing.
- `NATIVE_RELAY_ENABLED`: bounded nonstreaming text relay using the customer's own native `sk-` bearer; no owner API key. Exact models come from the existing selected-model manifest.

Public customer APIs live under `/api/native/customer`: GET `account`, `usage`, `keys`, `logs`, `logStats`, `billing/info`, `billing/history`; POST `keys`, `billing/checkout`; DELETE `keys/:numericId`. Customer mutations require exact same-origin requests and an opaque native session cookie. Create-key response reveals the raw customer key once and is uncached; list responses never reveal raw keys.

Key creation accepts `{name,models,quotaUsdCents,expiresAt}`. Models must currently be listed by the native station; quota is a key spending limit rather than a funded balance. The backend never generates native credit from that limit.

`POST /v1/chat/completions` requires customer Bearer key, `Idempotency-Key` of 16–100 alphanumeric/underscore/hyphen characters, approved exact model, text messages, `stream:false` and `max_tokens` at most 4096. The fixed upstream is `https://subrouter.ai/v1/chat/completions`; redirects and retries are disabled. Usage and actual charging stay native. Upstream model/usage identity must be valid before a response is returned.

Relay idempotency is a bounded process-memory admission cache, limited to 1000 dispatch identities and four concurrent requests. Identities are never silently evicted to allow another paid attempt. Restart loses the cache: do not claim cross-restart or multi-replica idempotency. A durable trusted admission store is required before public retry guarantees or unrestricted scaling. Ambiguous responses require native-log reconciliation and must not be automatically resubmitted.

Before charging customers, verify station listings/prices, actual native Stripe payment configuration, one native customer signup/login and key create, one bounded provider call, and native usage/payment receipts. A publish or true environment flag does not certify these checks. Preparation readiness remains closed and dormant Supabase finance-key SQL remains unapplied.

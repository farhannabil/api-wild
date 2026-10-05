# Native customer connection and staged activation

The native API account is separate from the existing Supabase business profile. No email-based identity mapping is performed. Subrouter's station is the only authority for customer API keys, credit quota and usage; no parallel Supabase ledger is written.

## Minimal first activation

After `https://apiwild.com` resolves to the Railway application with a valid domain certificate and the exact Host is preserved, configure one replica with:

```text
NATIVE_AUTH_ENABLED=true
NATIVE_CUSTOMER_ENABLED=true
NATIVE_KEY_WRITES_ENABLED=false
NATIVE_CHECKOUT_ENABLED=false
NATIVE_RELAY_ENABLED=false
```

These first two flags allow customer-entered username/password login and registration plus account, key-metadata, usage and billing-history reads. They need no owner API key, provider master key or Supabase service-role credential. Browsers receive only an opaque Secure, HttpOnly, SameSite=Strict cookie; upstream station cookies remain private process memory. Sessions expire in one hour and all sessions are lost on deployment/restart. Multiple replicas require a reviewed shared session store before activation.

The generated Railway preview hostname intentionally rejects native endpoints because it is not the configured customer origin. Do not relax the Host/Origin checks to bypass a pending certificate. Customer credentials and terms acceptance must be supplied by the customer through the form; no account or new API key has been created during deployment verification.

## Key writes

`NATIVE_KEY_WRITES_ENABLED=true` allows scoped key creation and revocation. Key budget is a spend limit, not funded credit. The adapter checks that requested exact model names are listed by the native station before key creation, and never returns old key secrets from list responses. New secrets are displayed once and are not persisted in browser storage.

Before activation, reconcile the station's listed models and custom retail prices with the approved public catalogue, verify native customer login/logout and a scoped key creation/read/revoke cycle with an authorized customer, and confirm the actual API endpoint accepts that customer's native token. Keep relay disabled until supply, funding and the approved single-call spending limit are verified. Do not substitute an owner token for customer authentication.

## Customer payments

The owner-approved minimum top-up is **USD 30**. The server rejects amounts below 3,000 cents before contacting the station; the upper bound remains USD 250. Customer UI defaults to USD 30 and uses the same minimum. USD 1 represents USD 1 of model credit; key quota limits do not create funds.

Checkout remains independently disabled unless `NATIVE_CHECKOUT_ENABLED=true` and the native station explicitly reports USD currency, a 1:1 exchange rate, an enabled Stripe method and an applicable native minimum. Payments are fulfilled by the native station. Returning from checkout never grants credits; only subsequently verified account quota/history indicates settlement. No payment, email or model inference was performed by these checks.

## Verification limits

Public preview account pages and their compiled assets load, and offline transport/ownership/CSRF/credit-boundary tests pass. This does not verify an actual customer cookie, payment settlement, supplier debit or model response. `/health/ready` correctly remains closed until launch acceptance is complete.

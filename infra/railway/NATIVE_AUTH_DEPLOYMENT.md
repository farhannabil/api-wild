# Native customer authentication mounting

The Railway preparation server mounts `/api/native/auth/login`, `/register`, `/logout`, and `/self`. The feature is disabled unless `NATIVE_AUTH_ENABLED=true`; unset or `false` keeps all native calls closed. This does not enable inference, funding, billing, or customer token writes.

Only the exact `https://apiwild.com` customer origin and `apiwild.com` Host are accepted. Railway generated domains cannot use these endpoints. No alternate origin has been configured. Configure the verified custom domain before activation; forwarded headers do not grant authority.

Native station destination is fixed to `https://apiwild.subrouter.ai`. Login and register forward customer-entered credentials only after explicit acceptedTerms; no owner API key is needed. Upstream session cookies remain private process memory. API WILD exposes only a Secure, HttpOnly, SameSite=Strict opaque cookie.

Run exactly one replica. The private store holds at most 1000 sessions for one hour, indexed by SHA-256 opaque handles, and drops every session on process restart, deployment, or sleep. This deliberately requires customers to log in again after those events. Never enable multiple replicas without a reviewed shared encrypted session store. No native cookie is persisted to disk or logged.

The HTTP bridge admits at most 20 concurrent native requests and 60 credential POSTs per minute process-wide. Add an edge abuse limit before public traffic; the bounded process limit can reject legitimate customers during load. Liveness remains `/health/live`; `/health/ready` remains closed because native auth alone does not complete launch acceptance.

Before enabling: verify custom-domain TLS/Host behavior, native station customer login/register settings, customer legal terms, actual native login cookie response and logout behavior, and restart logout expectations. Offline tests verify mounting and secret projection; no live customer has been created by this patch.

# Confirmed welcome worker: deployment configuration

This is a separate finite cron service, not the website service. Use the existing approved Railway project/environment and this repository's reviewed exact commit. Do not attach a domain, public network endpoint, healthcheck, paid model credentials or Stripe secrets.

Use `infra/railway/welcome-service-settings.reference.json` as the service's explicitly selected config-as-code path, or apply its settings to the matching service in Railway. A filename ending `.reference.json` is not autoloaded. It sets the welcome Dockerfile, one replica, Never restart, no HTTP healthcheck, and a proposed five-minute schedule. The CLI processes at most one claimed job and exits; no idle server or inference runs.

Configure these four values through protected Railway variables, never source, command arguments or chat:

| Variable | Required value / authority |
|---|---|
| `SUPABASE_URL` | `https://yautmilnpllojugpmfgy.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secure owner-controlled credential for that project; server-only RPC privileges |
| `RESEND_API_KEY` | Secure owner-controlled sending credential restricted to the verified `apiwild.com` sender where supported |
| `EMAIL_AUTOMATION_ENABLED` | Initially `false`; switch to `true` only after intended sender/domain and exact service/commit are verified |

Keep database claim limits unchanged: aggregate ten claimed attempts per UTC day, at most three attempts per event, database deferral within its 23-hour idempotency window. Each cron invocation requests one job. Stable provider idempotency is keyed by the existing event ID. Lost or malformed provider acceptance and lost final database writes remain ambiguous for reconciliation; do not force-reset or automatically replay them.

The service claims both active API WILD and AARO memberships supported by the existing shared outbox. It sends transactional confirmed-welcome messages, using existing `support@apiwild.com` branding logic. This is not a product billing merge. If deployment must be API-WILD-only, add a reviewed brand-scoped RPC before enabling; do not assume the service name isolates queue rows.

## Verification and observations

1. Deploy with email automation disabled and confirm a successful completed run logs only `enabled:false, claimed:0` and exits zero. That proves packaging/entrypoint, not sending or delivered email.
2. Confirm the existing migration's enqueue trigger, `claim_confirmed_welcome` and `finish_confirmed_welcome` service-only permissions and actual queue state with owner-scoped evidence. No client role can claim or finish jobs.
3. Before enabling, verify the intended confirmed-signup flow and sender-domain status. There may be existing pending queue rows; review count and intended brand/recipient ownership before a toggle.
4. Observe structured counters only: `claimed`, `providerAccepted`, `deferred`, `failed`, `ambiguous`. Provider acceptance is not inbox delivery. The current CLI throws sanitized generic errors and exits nonzero for missing configuration, invalid queue receipts or uncertain final writes. It does not expose addresses or credentials.
5. Inspect Railway run completion/exit code and protected database queue counters for liveness. This finite worker has no HTTP health endpoint. Alert on failed runs, ambiguous records or exhausted delivery budget; avoid logging customer addresses and provider error bodies.
6. To pause, set email automation false or remove the cron schedule. No separate recurring automation is required; avoid duplicate worker schedules.

No real email delivery or deployment is certified by offline tests. Root controls secure live configuration and acceptance.

Configuration fields checked against [Railway Config as Code](https://docs.railway.com/config-as-code/reference). The five-minute schedule is a bounded proposed cadence, not a claim that a schedule was installed.

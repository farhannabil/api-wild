# API WILD operations

The website and support receiver are separate deployments. Passing CI does not prove that a GitHub commit has been deployed.

## Support email

Supabase Edge Function `support-inbound` consumes only signature-verified Resend `email.received` events addressed to `support@apiwild.com`. Messages are retained in Resend Receiving. Acknowledgements use `API WILD Support <support@apiwild.com>` with Reply-To at that same address. They do not promise a response time, resolve tickets, or answer customer questions automatically.

Server-only Supabase secrets: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SUPPORT_AUTOREPLY_ENABLED=true`. Never put these in GitHub source, public CI artifacts, or the browser application. The receiver uses platform-provided database service credentials.

The delivery ledger and atomic leases prevent repeated sends from duplicate events and concurrent workers. Ambiguous retries reuse the frozen payload and Resend idempotency key for at most23hours, below Resend's24hour retention; older attempts require operator review. Replies from automated senders, own-domain mail, mailing lists and follow-up threads are suppressed. Limits are one acknowledgement per sender per24hours and75total per24hours; additional messages still arrive in Resend. These are conservative initial limits, not a support-response SLA. Delivered payloads are cleared after30days while dedup identifiers remain.

Daily database job `apiwild-support-daily-health` runs at13:17UTC, records aggregate delivery health, marks expired attempts for review and clears old delivered payloads. It does not delete incoming support mail. Inspect `support_daily_health` and `support_deliveries` using an authorized service/admin account. These tables deliberately grant no customer access. A `review` row requires human reconciliation with Resend before any new send; never reset it blindly.

Disable automatic replies by setting `SUPPORT_AUTOREPLY_ENABLED=false` in Supabase. Keep the webhook configured; failed events can retry. Restore only after verifying the receiver and credentials. Do not re-send an already-acknowledged message.

## CI and daily external checks

`.github/workflows/apiwild.yml` builds and runs tests for main commits, pull requests, manual runs and a daily schedule around08:17America/Winnipeg. It checks public routes, model data, auth boundaries, email DNS and the support endpoint. No customer signups, password resets or payment charges occur during daily checks.

The workflow uses pinned GitHub actions and read-only repository access. It never receives Resend credentials. `scripts/prepare-ci.mjs` creates a generic build-only hosting configuration when an exported repository omits the private Sites identity. Never deploy that temporary configuration.

GitHub scheduled workflows can be delayed and public repository schedules can disable after60days of repository inactivity. The separate daily operational review checks for missing/failed runs. An empty or unreachable repository is a failure, not a healthy pipeline.

Production publication stays with the verified Sites deployment process. A GitHub Actions runner must not fabricate Sites credentials or deploy unverified billing. Support Edge Function updates need the matching Supabase deployment authorization; this CI workflow only validates code. Commerce receipt/welcome/API-key delivery remains gated by its actual authenticated business event and verified payment configuration.

## Release checks

1. Run the existing build and tests (`npm test`).
2. Review provider/configuration changes separately from application diffs.
3. Apply new database migrations once and verify service-only grants.
4. Deploy the receiver and check `/health` plus unsigned-request rejection.
5. Verify an owner-controlled support message produces one delivered acknowledgement. Replay its signed event and verify no second send.
6. Record actual source commit, provider function version, migration and delivery evidence privately; publish no secrets or customer mail in repository issues.

Reference documentation: [Resend signatures](https://resend.com/docs/webhooks/verify-webhooks-requests), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [Supabase Cron](https://supabase.com/docs/guides/cron), [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

# API WILD transaction email pack

Eleven matching HTML and plain-text templates are ready. Open `preview.html` to review them with clearly marked example data. Support-received is active through the deployed Supabase support-inbound worker and inbox-verified; the other ten business templates remain disabled. Supabase Auth templates live separately in `supabase/email-templates` and do not send payment receipts.

## Delivery ownership

Canonical sender selection, 2026-09-08 (configuration and delivery acceptance still open):

| Event | Canonical sender | Duplicate prevention |
| --- | --- | --- |
| Paid Checkout purchase, receipt and paid invoice | Stripe native paid-invoice summary containing both invoice and receipt links | One financial-success notification; custom payment-received and invoice-ready stay suppressed |
| Successful partial or full refund | Stripe native | One notice per successful refund ID; custom refund-confirmed stays suppressed |
| Terminal payment failure | API WILD via Resend, disabled | Future durable outbox keyed by mode + order + terminal-failure transition; no mail for retryable decline, abandonment or expiry |
| Credits available | API WILD via Resend, disabled | Future fulfillment notice only after committed ledger; not a second payment receipt |
| Verified-account welcome, API-key lifecycle, support resolution | API WILD via Resend, disabled | Future durable outbox per canonical object and transition |
| Support acknowledgement | Existing API WILD support-inbound via Resend, active | Existing signed-event lease/dedup ledger and sender/day suppression |
| Auth confirmation, recovery and security notices | Existing Supabase Auth via Resend SMTP | Preserve provider-applied templates; no parallel business sender |

This selection is recorded in `manifest.json`; it does not activate a dispatcher. There is no automatic fallback to custom financial messages if native Stripe settings or delivery are unknown. A future sender change requires explicit approval and exactly-once delivery evidence. Test-mode manual receipt sending must be recorded separately from automatic production behavior.

Use Stripe's native receipt/invoice summary and refund emails as the authoritative financial messages. Inspect the settings under Stripe **Settings → Business → Customer emails** in the authorized sandbox; record actual values before any authorized change. Do not activate duplicate custom receipt/invoice sends. The custom payment, invoice and refund templates are inactive alternatives requiring a separately approved sender migration. Stripe controls its native receipt layout; these HTML files are not importable Stripe templates.

Checkout explicitly sets `payment_intent_data[receipt_email]` from the server-verified Supabase account, ignoring browser-supplied recipient fields. Reused Stripe customers are refreshed to that verified address before new Checkout sessions so invoice delivery does not retain an old account email. Existing-session retries reuse their original session without duplicate customer/session writes. Do not treat these settings, template preparation, or `invoice_creation[enabled]` as proof an email was delivered. One-time invoice creation has separate provider pricing; retain the billing integration's deliberate policy. Stripe test receipts require a manual send from the payment's receipt history. Resend domain verification does not configure Stripe's native sender branding.

Official reference, checked 2026-09-07: https://docs.stripe.com/receipts

## Integration contract

- Select a template and trigger from `manifest.json`; only support-received is enabled. There is no subscription in the current one-time credit purchase flow, so renewal/cancellation notices must not be emitted for these purchases.
- Verify Stripe webhook signatures and retrieve the canonical event/payment object where needed. Match order, account, currency and amount against the stored order. A checkout return URL is never proof of payment.
- The payment receipt requires verified paid status. Credits-ready requires both paid status and a committed credit ledger entry. An invoice requires paid invoice status. Refund confirmation requires a successful refund, including the actual partial amount. Never describe a pending refund as completed.
- Obtain the recipient from the authenticated account and its server-linked Stripe customer/order. Do not accept a browser-supplied arbitrary recipient. Support notifications require an actual stored ticket.
- Store a durable outbox entry atomically with the relevant business-state change. Deduplicate by template type, canonical business object and state transition (refund ID for separate partial refunds), not just webhook event ID. Enforce a unique constraint to withstand concurrency. Replayed or related Stripe events must not send duplicate emails.
- A sending worker retries transient failures with bounded backoff. Record provider message ID and delivered/bounced status; a provider acceptance response alone is not inbox delivery. Escalate terminal failures to operations without logging message tokens or secrets.
- Reject missing variables. Escape every dynamic text/attribute value before HTML substitution. Plain-text values must not be used as email headers. Format amounts from verified integer minor units using the currency's correct exponent and display the currency explicitly. No hardcoded tax, charge, or credit amounts.
- `receipt_url` and `invoice_url` must come from the server-verified Stripe object. Require HTTPS, no URL username/password, and an explicit exact-host allowlist for the supported provider URL. Never accept arbitrary customer-supplied links or use suffix matching. Do not log private receipt URLs.
- Set sender display name API WILD and approved authenticated sender address. Reply-To for support must reach the monitored contact mailbox. Do not promise response or settlement times without an actual policy.
- Verify a real owner-controlled test purchase, one receipt, credits-ready after fulfillment, failed payment with no success email, partial refund using its own amount, replay deduplication and cross-account denial before enabling customer delivery. Never create a real charge merely to test a template.

## Sender verification and remaining activation

Resend SMTP is verified for API WILD <noreply@apiwild.com>. On 2026-09-07 at 10:22:29 UTC, a Supabase recovery email arrived in the owner inbox with SPF, DKIM and DMARC passing and the canonical API WILD recovery link. This replaces the earlier Gmail credential blocker. No credential or token is stored here.

The support-received template is live through signature-verified Resend webhook events and Supabase function support-inbound. Its owner test arrived at11:51:43UTC from API WILD Support <support@apiwild.com>, Reply-To support@apiwild.com, with SPF/DKIM/DMARC passing. Same-event replay returned200 recorded and did not produce a second send. Operator messages remain in Resend Receiving; no external forwarding or autonomous resolution is configured. Other business templates still need their authenticated event/outbox connection. See OPERATIONS.md for limits, retry handling and daily checks. Auth SMTP verification does not activate Stripe receipts.

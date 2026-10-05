# API WILD transactional email configuration

All eight live Supabase Auth template footers were updated to support@apiwild.com on 2026-09-07 and individually preview-verified. Password-change and email-address-change security notifications are now enabled; both persisted switches were verified after navigation. The email-change subject was visually verified because DOM input-value inspection incorrectly returned an empty string. Resend SMTP delivery was previously verified at 10:22:29 UTC: an authorized recovery email reached the owner inbox from API WILD <noreply@apiwild.com>. SPF, DKIM and DMARC passed; one branded recovery heading and canonical apiwild.com/auth/complete token-hash link were verified. No token was consumed and no password changed. The updated footer has provider-preview evidence, not a new inbox-delivery test.

- Live Auth sender: API WILD <noreply@apiwild.com>, through Resend smtp.resend.com:465. Domain verified; credential is sending-only and scoped to apiwild.com. The earlier delivered test had no Reply-To header and its then-current footer used contact@genxintel.com. Receiving at support@apiwild.com is now independently verified; all eight live footers now use that address. SMTP Reply-To remains unchanged.
- Authenticate the sending domain with the chosen provider’s SPF/DKIM requirements; inspect DMARC alignment. Store SMTP credentials only in Supabase/provider settings.
- Apply the HTML and subjects in manifest.json to the corresponding Supabase Auth templates. These links use the deployed manual confirmation page and token hashes; opening a link alone does not consume the token.
- Set Site URL to https://apiwild.com and allow https://apiwild.com/auth/complete plus https://apiwild.com/auth/complete?flow=recovery. Preserve approved Sites-origin callback URLs if customers use that origin.
- Disable link tracking/rewriting for authentication messages. Keep email confirmation enabled.
- Send a fresh owner-controlled confirmation and recovery message after applying configuration. Old localhost links are not repaired retroactively.
- Verify From name/address, Reply-To routing, both email-change confirmations if enabled, mobile rendering, link expiry, inbox confirmation and password recovery before marking applied.

Support acknowledgement, now active behind signature-verified received-message events:

Subject: We received your API WILD message

Thanks for contacting API WILD. We’ve received your message and will review it. You can reply to add details. Please don’t include passwords, API keys, or sensitive customer data.

API WILD Support
support@apiwild.com

The support acknowledgement is now live and inbox-verified. Farhan specifically approved the dedicated Full access key and Supabase-only secret storage on2026-09-07, superseding the earlier approval block. The signed support-inbound receiver suppresses automated messages, repeated events and follow-ups. The actual owner reply arrived from support@apiwild.com with that same Reply-To and SPF/DKIM/DMARC passing; provider replay did not send again. Welcome and commerce triggers remain disabled. No response-time promise is made.

Commerce receipts, payment failures, refunds, invoice notices, welcome and support templates are in `../../emails/transactional`. Only support-received has an activated business delivery trigger; the other ten templates remain prepared.

## Current account/catalog repair — 2026-09-07

This checkpoint supersedes older connection, logo and pricing statements below.

- LIVE ROOT CAUSE: the actual confirmation email delivered to owner-controlled farhan@genxintel.com at 06:59:44Z contains redirect_to=http://localhost:3000. Do not store or reuse its verification token. Correct provider Site URL/allowlist and issue a fresh email. Current connected Supabase project is yautmilnpllojugpmfgy, ACTIVE_HEALTHY; runtime public config is verified. Connector has database access but no Auth config/SMTP mutation surface.
- Implemented explicit implicit-session, PKCE (including flow ID), token-hash confirmation and recovery handling, manual scanner-resistant token confirmation, callback fallback on known auth paths, URL secret cleanup, visible error/resend/signin recovery and delayed network feedback. No confirmation bypass.
- Replaced rejected logo with minimal geometric circle/slash mark and API WILD wordmark across pages/workspace/favicon.
- Refreshed all 581 OpenRouter models across 8 output modalities from output_modalities=all and exact frontend displayPricing at 07:11:19Z. Includes 69 provider images and 70 available model previews, full modality filters, actual pricing units and tiers, synchronized context-tier calculator. Free router is free; negative-rate dynamic routes are labelled dynamic. Custom services require quotes; unsupported fixed packages removed. Snapshot reference prices are not live inference entitlements.
- Prepared 8 branded Auth templates and support acknowledgement copy in supabase/email-templates. NONE applied to Supabase. No automated support responder is connected or claimed sent.
- Verification: 25 automated tests, TypeScript and production build passed; workspace JS and diff checks passed. Preview confirmed catalog filtering, Veo video SKU pricing, calculator context-band total $350 for 10M input + 2M output above 272K, new logo and manual confirmation screen. Preview callback shows visible recovery actions when config is unavailable. No real signup/password recovery/persisted browser-session acceptance claimed.
- BLOCKER OWNER: Farhan Nabil / Gen X Intel. Exact required item: finish secure Supabase dashboard sign-in (browser currently at Google password step after user takeover), then authorize/access the existing verified SMTP sender configuration. Set Site URL https://apiwild.com and exact /auth/complete + recovery redirects; apply branded templates and sender. No credentials in chat. Closing gate: fresh inbox confirmation → onboarding save → signout → fresh-session login/persisted profile; recovery mail → changed password login; inspect sender and Reply-To. Old email cannot be repaired by website deployment.
- Safe interim: publish verified frontend/catalog/branding changes to existing public audience. Keep full account acceptance open. Billing, inference and legacy D1 migration remain inactive/unverified. Do not enable downstream billing/inference without their credentials and real evidence.

Provenance before this publication: site/service https://apiwild.com → GitHub farhannabil/api-wild MISSING/UNVERIFIED (actual source Sites-managed Git main; establish authorized mapping) → production commit 08020ee79769088b988db3dff921637f03f2c462/version 12 → Linear GEN-10 (checkpoint 91c6c394-0307-4f81-a9a8-9820c40c9f86) → Gen X Intel/contact@genxintel.com → succeeded deployment appgdep_6a9e600b0758819185246cf0d96f3860. New source publication pending; this is not evidence it is deployed.

## Connection update — 2026-09-07

The user successfully connected Supabase during this repair. This supersedes earlier unavailable/not-connected statements below. However, the active execution registry still exposes zero Supabase tools, and no tool-search capability is available to load them. Do not ask the user to install/reconnect. Resume provider checks when the newly connected tools are exposed in a refreshed turn. No database/provider change is claimed from connection alone.

# API WILD customer-auth release gate

Prepared code and email templates are not evidence of production activation.

## Owner and exact prerequisites
Owner: Gen X Intel (contact@genxintel.com), with API WILD engineering.
Intended project from prior verified handoff: api-wild-production / yautmilnpllojugpmfgy. Reconfirm via the Supabase connector before mutations. Do not use the inactive unrelated project.

- Use the now-connected Supabase when its tools are exposed to inspect project state, RLS, auth config, SMTP and logs.
- Verify Site runtime SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY. The current runtime read returned project_not_found although Site/source reads succeeded. Local preview does not contain these values. Never put service-role secrets in the public config endpoint.
- Set/verify Site URL https://apiwild.com and allow the email redirect URLs https://apiwild.com/auth/complete and https://apiwild.com/auth/complete?flow=recovery. Preserve any previously approved redirect used by issued links.
- Verify email confirmation is enabled, password rules and request rate limits. Configure the authorized SMTP provider and sender name API WILD using a verified sender domain; credentials must remain in the provider settings.
- Review and apply email-templates/confirmation.html (subject: Confirm your API WILD email) and recovery.html (subject: Reset your API WILD password). These templates were only saved as source in this repair.
- Verify customer_profiles columns user_id, full_name, company_name, role, use_case, onboarding_data, onboarding_completed_at, updated_at; verify the auth-user trigger and RLS SELECT/INSERT/UPDATE policies use auth.uid() = user_id. Check DELETE/grants according to the existing intended policy. Browser form validation is not a substitute for database constraints/RLS.

## Closing verification
Using owner-controlled test accounts, prove signup → inbox confirmation → onboarding → persisted profile → reload → signout → second-session login. Test forgot-password email → reset → login using new password, expired links, duplicate signups and resend rate limiting. Confirm two-account isolation including direct REST reads and writes and anonymous denial; do not use real customers or expose secrets in logs. Real customer email and account creation require the owner-controlled test identity, not a fabricated customer.

## Separate migration gates
The current Supabase console intentionally leaves API keys, usage, billing, team roles, guardrails and provider connections inactive. Legacy D1 account/brief endpoints still use the original hosting identity and are not Supabase customer APIs. Migrate and test those server-side features before enabling them. Existing D1 tests are fixture evidence only. Original planning workspace exports remain available. No live payments or inference are enabled by this change.

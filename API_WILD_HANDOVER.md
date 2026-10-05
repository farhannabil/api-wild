# API WILD — agent handover

## General web search and customer launch — October 5 source checkpoint

- Customer workspace now defaults to general web search through DuckDuckGo's official HTML search endpoint, with up to five cited results. Explicit Wikipedia search remains available; article summaries remain restricted to English Wikipedia. Public search can return outages/challenges and has no paid service guarantee. No CAPTCHA bypass, result-page scraping, automatic retries or paid fallback is implemented.
- Searches use the owned authenticated endpoint and existing owner rate/concurrency limits. Only two pinned public HTTPS hosts are fetched, with verified TLS, no redirects/authentication/cookies and finite deadlines/body limits. Search results are untrusted editable context; adding them never sends a model request by itself.
- Customer model picker offers only currently enabled routes; an existing conversation or uncertain retry keeps its selected model and exact saved request. Onboarding no longer incorrectly says inference/payments are inactive. Live Stripe API verification confirmed the existing account, charges enabled, active USD credit price and enabled production payment/refund webhook. Signed-in Credits opened an actual branded live USD30 checkout without paying; cleanup evidence is private outside Git.
- Local387 application tests and51 focused integration checks passed. Backend/frontend source and model-picker changes received independent review. Source receipts are under `.claude/it-team-evidence/`. Root must still verify the exact final Railway deployment, CI, signed-in general web search and current health before reporting production completion.
- Launch scope is paid text customer onboarding,24 accepted models/72routes and manual research utilities. Hosted audio is explicitly next sprint. The larger Subrouter marketplace is separate from approved executable API WILD routes; catalogue expansion does not block signup on accepted routes. Supplier caps/expiry, reservations, retail prices and existing genuine sandbox acceptance remain unchanged; no new deposit or paid model probe.
## Advanced workspace tools and browser voice — October 5 source checkpoint

- Added authenticated `POST /api/research/tools`: English Wikipedia search (up to5 cited results), article summaries (up to6,000 characters) and deterministic arithmetic. Session ownership or research-scoped hashed keys are required; the endpoint does not reserve/debit model money. Bound8 requests per owner/minute on the current server, separate2-request utility pool,5-second external deadline,64KiB bodies, public DNS pinning, verified hostname TLS and no redirects/auth headers.
- Customer Chat/Research/Code now include review-and-add source evidence, UTF-8 plain-text attachments (20KB), browser microphone dictation and read aloud. Dictation starts only on explicit customer action, has a60-second cutoff and never overlaps owned playback. English/Bangla options reflect browser/device availability. Browser-provider audio processing is explained. Hosted `/v1/audio` endpoints and general web search are not implemented; no autonomous function/code execution is claimed.
- Existing24 models/72 routes, customer tariffs, immutable paid request/replay bodies, supplier key restrictions/caps, financial reserves and prior genuine sandbox acceptance artifacts are preserved. No new paid inference, card charge, email, secret, deposit, top-up or supplier route was used.
- Local381 application tests passed; focused gateway/utility/container/voice checks and Railway build passed. Root reviewed backend/frontend; independent backend worker reviewed gateway integration and verified free searches cannot starve paid/account slots. Actual default Wikimedia transport returned5 cited Canada results and a698-character Canada summary. Source receipts are in `.claude/it-team-evidence/`.
- This source checkpoint is not an observed production deployment. Root must verify both exact-main CI workflows, Railway deployment commit/readiness and signed-in live search/read/calculator before marking release verified. Actual microphone/audio hardware remains untested. GEN-10 stays In Progress for broader integrations, excluded models and sustained hosting.


## Reviewed text-production release — October 5

- This release expands the reviewed configuration from19 to24 models across Chat, Code and Research (72 routes). Five additions passed exact response/native-wallet checks: claude-opus-4-8, claude-sonnet-5-5, glm-5.1, glm-5.3 and grok-4.7. Existing57 route fields, retail prices, primary offers and MiniMax-only function-data support are preserved. Three private backup catalog objects change; rejected candidates remain disabled.
- Before this expansion, production commit `30da58aa97bda200418d2128c112661c04b02433` and deployment `b6f7a5f8-62ec-4514-8fcf-de1e91010e6f` were verified successful. Both main workflows passed and all31 deployment-aware health/auth/page/email checks passed after admission restoration. Verify this release's exact deployed commit and24-model count through `/health/ready`, `/api/gateway/config` and the latest [Linear checkpoint](https://linear.app/genxintel/issue/GEN-10/build-ai-model-api-resale-platform).
- Owned API WILD signup/confirmation, accounts, personal keys, live USD prepaid Checkout ($30 minimum), retail usage and private supplier reconciliation are configured. One genuine sandbox lifecycle passed paid Checkout, signed exactly-once credit, owned model response/retail debit, duplicate-safe replay, native supplier charge reconciliation, full signed refund and test-key revocation; final net sandbox credit0 and live-wallet isolation were read back. Live Checkout was inspected unpaid and expired. No live paid customer purchase is claimed.
- Shared supplier lifetime authorization remains within¥50 across test/production keys, expires November4 at10:25:19UTC and has no deposit or automatic top-up. After these17 one-shot tests, the owned operating allowance is¥48.912362: direct native debits reduce it conservatively by¥0.001528, with¥0.080395 retained as unconfirmed/rejected-attempt reserves. Reserves are not actual receipts. Existing personal keys and all unrelated services are unchanged.
- Supplier key restrictions were changed exactly once to the19 approved replacements. The subsequent13-model continuation performed zero key updates and never repeated the original four attempts. Five of17 candidates passed; all12 rejected candidates remain excluded. Two DeepSeek models were not probed because served-version/peak supplier tariffs are unresolved; Gemini3.5FlashLite still needs documented expression/cache units and a finite bound. The39-entry catalog is not39 callable models.
- Deployed recovery settings: `/health/ready`,30-second timeout, ON_FAILURE restart(max3). Receipt and reservation-expiry workers are enabled; actual observed scans had0pending/noerrors. Over-limit observed supplier input holds both reservations and returns no answer. Uncertain requests require manual reconciliation; automatic recovery is not claimed.
- Research analyzes model input without external browsing. MiniMax-M2.7-highspeed alone has accepted function-call data; no external function executes. Search, voice/media, native Responses/Anthropic, broad coding-agent compatibility and enterprise features remain unavailable or unverified.
- One approved owner test email was delivered. Custom welcome sending remains off. No additional email, real card charge, supplier top-up or hosting upgrade was performed. Railway trial hosting still needs an owner decision for sustained service.
- Historical missing-secret, zero-budget, one-day-key and disabled-checkout/inference statements below are superseded. GEN-10 remains In Progress for the broader project. Release evidence scopes retain genuine sandbox acceptance separately from live configuration and direct supplier tests.

---

## Historical checkpoints — superseded where noted above

## Verified Stripe completion checkpoint — October 5

This checkpoint supersedes the earlier refund-release BUILDING status below.

- Refund fix commit `74303cb6b15f2d15d42243499101ce27d7550751` was verified **ACTIVE / Deployment successful** in Railway deployment `82fc9043-e4f3-474a-a861-cd033b90fd0e`. The newer documentation commit does not itself establish a newer production runtime.
- Live one-time USD credit product/price, restricted server billing key, signing secret, API WILD checkout branding and 13 owned webhook subscriptions are configured. Minimum purchase is USD30. The live unpaid expiration event and its replay returned HTTP200; both private live checkout sessions were expired without payment and no production credit was granted.
- Authorized Stripe sandbox checkout paid USD30. Genuine Stripe-signed events exercised the application handlers and SQL-backed ledger in an isolated local acceptance harness: one +3000-cent credit, cumulative partial refund -2000, final refund -1000, ending at zero. Payment/refund duplicates returned `replayed=true` without duplicate ledger entries. These are sandbox/local ledger results, not paid production acceptance.
- Canonical Stripe Refund objects omit `livemode`; the released fix allows omission while retaining event/account/canonical PaymentIntent mode and ownership checks. All 63 focused billing tests passed. Dispute paths have automated coverage, not a real dispute acceptance run.
- No real card was charged. The earlier self-charge acceptance plan is superseded: [Stripe testing guidance](https://docs.stripe.com/testing) requires sandbox testing rather than live-mode tests with real payment details.
- Public credit purchases and inference remain disabled pending dedicated restricted upstream credentials, accepted supplier budgets/FX/reserves, and bounded inference delivery/reconciliation. Full API WILD launch remains incomplete. The earlier nullable-key release and owner-confirmed live spending-limit save remain verified.


Updated October 05, 2026, 12:13 AM America/Toronto. Owner: Farhan / Gen X Intel. Issue: [Build AI model API resale platform](https://linear.app/genxintel/issue/GEN-10/build-ai-model-api-resale-platform).

## Early October 5 wrap-up checkpoint

This section supersedes earlier statements about the latest GitHub head and “building” status. Historical evidence below remains useful, but is not a current configuration read.

- GitHub main was freshly read at `cb979483e1a605639d4e21215bbcc59eb2bbe0c2`, with tree `792fe7499e177febf84ce5f5a5ff593eec4b3c20`. Two newer checkout/billing commits preserve the key release. Always fetch main again before editing or publishing; another customer-launch chat is actively fixing a sandbox refund issue.
- Earlier key release `be1efe231fb7bc5bacbfe961b4a700d15534a932` was personally verified ACTIVE/successful on Railway. The nullable Supabase migration, server-only key issuance and workspace controls were verified. The live Account spending setting saved successfully. Deployment of later billing or this wrap-up release must be verified separately.
- Final source audit found most dirty checkout files already published. An isolated eight-file email/container patch on current main passed 73 focused tests. It adds missing runtime files to the closed website context, packages the existing welcome RPC adapter, bounds Resend receipts and deadlines, and updates worker deployment references. It does not install or enable a worker, send email, change production config, or alter the five newer billing files. Docker is unavailable here; Railway's actual container build remains required.
- The separate customer-launch chat reported a successful sandbox $30 purchase and local credit projection, and found a refund-validation issue. Those are sandbox/local results, not proof of production payment fulfillment. Read that chat's latest evidence and main before taking over billing.
- Railway now visibly lists Stripe server key, webhook secret, credit Price ID and Supabase secret variable names. Their values were not inspected or exposed. The selected Subrouter business key remains absent from the visible service variable list. Paid production purchase-to-response acceptance remains unfinished.

### Personal Codex connection and Windows transfer

[Subrouter-powered Codex verification ticket](https://linear.app/genxintel/issue/GEN-31/verify-subrouter-powered-codex-desktop-and-manual-subscription) is separate from API WILD's production inference task. The user approved the device authorization, including its displayed account-management scope. GPT-6 Astra completed Responses streaming, function/result continuation, a real bundled-Codex terminal/file-read task, and a strict command-backed credential-helper test. Both actual CLI turns exited successfully. Nonsecret desktop settings were saved with a rollback copy; ChatGPT auth was not replaced. The Mac desktop has not been deliberately restarted by this task, and a new GUI task using Subrouter has not been established. Keep the ticket open until actual target desktop verification passes.

Read [CODEX_SUBROUTER_WINDOWS_HANDOVER.md](CODEX_SUBROUTER_WINDOWS_HANDOVER.md). Windows needs its own secure credential availability and native config/helper paths. Do not transfer private credentials, the entire Mac config, auth cache, or helper output through GitHub or Linear. Subrouter is a manual provider choice and bills its own balance; it does not replenish a ChatGPT allowance or automatically activate when quota runs out. Plugins, browser, voice and cloud capabilities require separate verification.

### Persistent VPS work — requested, not installed

The user asked about his two existing Hostinger VPSs. Their identities, resources, operating systems and access are not yet verified. Current local sub-agents do not automatically migrate or continue after the desktop closes. No persistent remote runner has been installed and no remote jobs are active. The Hostinger VPS connector is not loaded; this Mac config lacks its required MCP registrations. Complete the Hostinger plugin setup and its documented restart/authentication, then inspect both servers before selecting a runner. Do not claim remote continuity, invent server details, copy secrets into repository files, or replace existing VPS workloads.

A future remote runner needs its own authenticated model connection, checked repository access, explicit tasks and durable job/log state. Preserve this repo/Linear evidence first so Windows or a future VPS task can resume without depending on a running Mac session.

## Later publication and connectivity checkpoint — October 5

- Published wrap-up/email release `4928bc969161a2ec640a5cdf11a1c3c61965a00e` is ACTIVE / Deployment successful in Railway. The eight-file packaging change passed 73 local tests; actual live email delivery remains unverified and worker activation was not performed.
- GitHub main then advanced to `74303cb6b15f2d15d42243499101ce27d7550751` (“Handle canonical Stripe refunds without a livemode field”), changing two refund source/test files. Railway showed that newer deployment BUILDING at inspection. Verify its final health and actual payment ledger before claiming it active.
- Railway currently shows 14 service variable names including Stripe server key, webhook secret, credit price and Supabase secret. Values were masked and not read. No private Subrouter business-key name appeared in the visible list. Do not repeat the earlier statement that all Stripe credentials are missing.
- The Mac's global `model_provider=subrouter` was removed after a new-chat send complaint, leaving the optional Subrouter profile/provider available for manual use. Unrelated model/plugin settings were preserved. A default-provider Codex CLI prompt completed with `chat-ok`. The browser bridge reported an unavailable Codex auth token, but that alone did not establish the native UI cause. The new-chat GUI send was not retested here. GEN-31 records the diagnostic and remains open.

## Historical key-release sync checkpoint

GitHub main be1efe231fb7bc5bacbfe961b4a700d15534a932, Supabase nullable migration and Railway active deployment are synchronized for the latest completed application changes. Account spending controls and nullable-key UI are verified live. **Sync complete does not mean paid launch complete:** Stripe server/signing secrets, upstream key/routes/accepted budgets, supplier tariff/funding and real purchase-to-response acceptance remain open. The handover is current; older attached copies that still say BUILDING are stale.

## Read this first

**The public website, confirmed Supabase customer account, customer key metadata, and usage ledger are live. A customer cannot yet complete a paid model request. Production launch is NOT complete.**

The latest approved architecture is **API WILD-owned customer accounts and credits**: Supabase Auth/database, Resend confirmation email, Stripe prepaid top-ups of at least USD30, hashed API WILD keys, own retail ledger and gateway, and private Subrouter upstream inference. Leave the native Subrouter customer portal, station Stripe, SMTP/SMmails, and OAuth/session-handoff work alone. They are superseded, not current prerequisites.

User wants clear, simple customer navigation and quick execution. Address him as **Broski**; do not use “checking that now.” He reported ADHD and needs one concrete action at a time for owner-only credential/payment steps. Do authorized code/release work without repeated approval questions. Do not claim saved source, a completed agent turn, or a passing fixture is verified production.

## Current provenance — freshly checked

| Field | Evidence |
|---|---|
| Website/service | https://apiwild.com → Railway apiwild-candidate / api-wild / production |
| GitHub repository | https://github.com/farhannabil/api-wild, main, existing public visibility retained |
| Latest published main | be1efe231fb7bc5bacbfe961b4a700d15534a932 — Add optional API key spending limits and permanent expiry with enforced revocation |
| Previous core release | 5edd0f6488a100f88aea43c529d57d48ef8b889e — Connect Supabase customer keys, prepaid credits, usage and model playground |
| Railway evidence | Latest key release be1efe ACTIVE / Deployment successful, deployment84520782-b6a7-4ceb-99b1-fbabc7b74fe4. Workspace activation retained |
| Production UI evidence | Refreshed /console/api-keys shows simplified navigation, No daily key limit, No total key limit, Never expires, and both user-created keys Revoked. Account policy loaded USD10/day and unchanged save returned Spending settings saved |
| Customer acceptance evidence | Real Resend confirmation email arrived; user confirmed signup/onboarded. Signed-in usage loaded actual zero-credit ledger |
| Linear | GEN-10, Build AI model API resale platform, In Progress; new comprehensive checkpoint saved |
| Owner/account identities | Farhan / Gen X Intel; publisher farhannabil; existing Main Stripe account retained |

Railway project: 54debd1f-3b66-4593-b874-d602be0b4048.
Service: af8ce804-b94b-4721-a858-0253d8eeabb2.
Production environment: e07d7cec-b900-4847-9010-80ebf28be959.
Region: US West, one replica, Docker listener 8080.
Preview: https://api-wild-production.up.railway.app.
Production Supabase project: yautmilnpllojugpmfgy, api-wild-production, PG17.6, ca-central-1.

## Eleven launch workstreams — completion audit

The user asked to audit eleven sub-agent tasks. The current collaboration roster contains **three agents**. Eight historical names are recoverable; three additional historical agent identities could not be verified from the current roster, app chat list, or artifacts. The eleven rows below audit the actual launch workstreams; they are **not an invented eleven-agent roster**. See the historical-name appendix and outputs/historical-agent-task-audit.md.

| # | Workstream | Verified state | What remains |
|---|---|---|---|
| 1 | Source recovery, repository access, Railway packaging | Commerce folders compared with newer GitHub source; originals preserved; GitHub app access resolved; reproducible Docker/runtime fixes and dependency release deployed | Verify future changes against current main; do not republish old folders over newer source |
| 2 | Main domain, Cloudflare, HTTPS | apiwild.com reaches Railway; valid HTTPS; Cloudflare/GoDaddy cutover resolved | Routine monitoring; no further domain migration needed |
| 3 | Selected catalog, retail prices, public branding | 39 selected entries and latest approved rate policy published; supplier names/costs/ratings/availability removed from public presentation | Refresh comparable official/OpenRouter references before new claims; catalog count is not active route count |
| 4 | Model detail pages and comparisons | 39 detail pages implemented/published; historical check report: 37 matched reference specs, no render failures, unknown model404 | Latest per-page acceptance and uncertain alias/capability references remain distinct from tested supply |
| 5 | Supabase signup, login, onboarding | Confirmation required; real signup/email confirmation/onboarding and signed-in ledger read completed; personal profile hides company domain | Full logout/login/password-reset/cross-account regression; social auth under Supabase is not established by older station OAuth setup |
| 6 | Resend email | Supabase SMTP/redirects/branded confirmation template configured; real confirmation email delivered | Password reset/retry/duplicate behavior and optional welcome-worker deployment/credential/budget verification |
| 7 | Customer API keys, revocation, optional limits | Core key issue/list/revoke deployed; user-created keys display revoked. Nullable expiry/caps migration now applied; matching backend/UI published; 12 runtime + SQL integration + 3 frontend tests passed | New controls and revoked metadata confirmed live; real new-null-key issuance/auth lifecycle still requires owner credential creation/takeover if exercised in browser |
| 8 | Credits, usage, account spending policy | Own zero-credit initialization/ledger/usage deployed; actual usage totals load. Workspace schema/code published/applied; OWN_WORKSPACE_ENABLED=true deployed | Live account controls load and current daily cap save succeeds; DB policy enforcement verified by SQL integration, no paid request. Customer planning budget is not purchased credit |
| 9 | Stripe checkout and fulfillment | Live USD1 credit-unit Price and existing webhook verified; USD30 minimum; local replay/refund/dispute SQL checks pass; handlers deployed | Fresh server credentials/signing secret; real signed event → exactly-once credits; legacy invoice/subscription handling review; purchase/refund acceptance |
| 10 | Subrouter supply, model routing, supplier accounting | Private dispatch and retail/supplier separation implemented; route manifest39, standard tariffs37 compiled | Fresh upstream token, exact provider/model restrictions, accepted bounded budgets, FX/reserve values, 2 DeepSeek policies, funding and paid receipt reconciliation |
| 11 | Playground, docs/configs, model categories, tools | Owned text Chat/Code/Research screen deployed; placeholder config exports; one simple screen with mode selector | New OpenRouter-inspired category/playground request deferred for this handover; streaming/tools/media/server execution not implemented; real model response untested |

**Conclusion: not all launch workstreams are complete.** Research, UI releases, and local implementations are substantially delivered; Stripe fulfillment and model execution still block customer launch.

## Latest instructions and product decisions

- Keep the existing apiwild.com website on Railway. Supabase owns customer authentication. Subrouter only supplies inference using a private business credential.
- Minimum top-up USD30, one-time credits; no newly authorized subscription/auto-recharge workflow. Credits are retail value, not forwarded dollar-for-dollar to Subrouter.
- Main navigation: Overview, Models, Chat, Usage, API keys, Credits, Account. Code/Research are modes in Chat. Daily spending controls under Account; capability controls under Advanced. Do not revive Members/Roles/Guardrails/Provider Connections as primary navigation or show an unimplemented BYOK input.
- Keys: Never expires / No daily key limit / No total key limit use real nulls. Defaults remain USD5/day, USD25 total, 30 days. Limits cap spending; they do not add funds. Unlimited key limits cannot bypass funded account balance, account daily cap, or supplier budgets. Revocation blocks new authentication/reservation/dispatch claims; do not promise canceling a request already sent upstream.
- Per-model key restrictions are not implemented in the current owned key contract; capabilities are chat/code/research. The model dropdown in key docs selects an example, not key authorization.
- Owner pricing changed several times: **use current data/selected-supplier-models.json and outputs/owner-selling-price-decisions.json**, not the original first-seven prices. General policy is half official with explicit subsequent overrides. Token input/output comparisons must remain on matching per-million units; supplier quote is not verified debit.
- User wants OpenRouter-style model selection, coding/reasoning/roleplay/flagship discovery and playground, with API WILD branding. Do not fabricate best-model rankings or enable unsupported tool controls.
- Phone/country validation currently checks required international format. SMS possession, authorized number vendor and disposable-number detection are not implemented.
- WordPress uploads were identified and explicitly set aside: ARMember7.8.2, ERPGo Laravel business app, YellowPencil7.6.7, TownHub1.9.1 twice byte-identical. None installed. Do not turn this launch into WordPress integration.

## Applied database changes

Root applied and verified these production changes:

1. confirmed welcome outbox / earlier apiwild gateway portability foundation.
2. supabase/migrations/20261005010000_apiwild_stripe_projection.sql.
3. supabase/migrations/20261005010100_apiwild_stripe_checkout.sql.
4. supabase/migrations/20261005030000_retail_supplier_separation.sql.
5. infra/railway/runtime/customer-key-rpc.schema.sql.
6. supabase/migrations/20261005031735_workspace_policy.sql, generated using official Supabase CLI.

Private finance/key/payment tables have RLS with no public policies by design. Server-only RPC execute grants were checked: anon=false, authenticated=false, service_role=true. Workspace reservation policy also rechecks when a held request changes to executing.

**Now applied and verified:** supabase/migrations/20261005032721_nullable_customer_key_limits.sql (nullable_customer_key_limits). It drops only key cap/expiry NOT NULL constraints and replaces key lifecycle/reserve/claim logic with explicit nullable checks, preserving account/provider restrictions.

No provider budgets exist; no accepted inference rows have been seeded. No financial fixtures were injected into production. MCP migration versions differ from local filenames and earlier history; a clean CLI migration-history alignment has NOT been verified. Inspect before any migration repair; do not silently rewrite immutable applied migrations.

Local PGlite tests executed actual SQL, not mocks only: duplicate payment events, credit projection, refunds/disputes, revoked-key auth/reserve/claim rejection, unlimited-key zero-credit rejection and account daily cap preservation. These tests are not live Stripe/customer acceptance.


Post-migration security advisors retain expected INFO notices for deliberately private RLS tables with no public policies, plus the pre-existing disabled leaked-password protection warning. Reference: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection. No new public key/finance function access was granted.

## Railway configuration — names only, no secrets

Latest variables-page inspection shows12servicevariables. The workspace flag was saved and its deployment confirmed ACTIVE:

- APIWILD_BILLING_MODE=live
- APIWILD_INFERENCE_ENABLED=false
- APIWILD_OWNED_GATEWAY_ENABLED=true
- BILLING_MODE=live
- NATIVE_AUTH_ENABLED (older saved flag; value masked)
- NATIVE_CUSTOMER_ENABLED (older saved flag; value masked)
- OWN_BILLING_ENABLED=true
- OWN_WORKSPACE_ENABLED=true
- STRIPE_CREDIT_PRICE_ID=price_1UN10k194XZKj6cFzuuvwE8T
- SUPABASE_PUBLISHABLE_KEY (masked)
- SUPABASE_SECRET_KEY (owner personally saved, masked)
- SUPABASE_URL

Root entered the known non-secret values above; do not reveal/read masked secret values. Older native flags remain in Railway but do not define the latest approved architecture.

**Missing from current list:** STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUBROUTER_API_KEY, APIWILD_GATEWAY_ROUTES_JSON, APIWILD_RETAIL_RATE_VERSION.

OWN_WORKSPACE_ENABLED=true is deployed. Live account controls load the USD10/day cap and a same-value save succeeded. SQL integration proves reserve/claim restrictions; no paid inference enforcement test yet.

Owner must enter new credentials directly into the prepared Railway fields and submit, under browser credential-entry rules. Do not paste exposed chat keys, ask for secrets in chat, print clipboard contents, or store plaintext secrets in local docs/release bundles.

## Stripe exact setup and remaining acceptance

Existing Main Stripe account acct_1UCiHN194XZKj6cF, 2740797 Ontario Inc.
Product prod_VNmZwZXPlUXiIX.
Price price_1UN10k194XZKj6cFzuuvwE8T: live, active, one-time USD1 credit unit.
Existing live endpoint we_1UCyJf194XZKj6cFMlnobTtq:
https://apiwild.com/api/billing/webhook, API2026-08-26.dahlia.

The owned webhook subscribes to all13 checkout/refund/dispute events needed by the projection. It also has10 legacy invoice/subscription events that current one-time code rejects422. Do not silently acknowledge/drop those events or delete subscriptions. Inspect legacy fulfillment obligations and route appropriately.

Runtime Stripe SDK pinned22.6.0; defaultAPI2026-08-26.dahlia. Missing credentials keep checkout unavailable rather than allow payments without fulfillment. Never credit on browser success-return alone. Webhook signature verification, durable event replay and exactly-once ledger are authoritative.

No customer purchase/refund was performed in this current release. No bounded test amount/provider spend ceiling was finally approved. The user wants to do the live test together; complete preparation first, then ask for one specific bounded action. Do not start accepting customer credit sales before delivery is proved.

## Inference activation — genuine remaining work

Manifest: outputs/inference-activation-manifest.json.
Rate version: catalog-864cc868f68ac9bdf3be.
Supporting review: outputs/inference-activation-notes.md; outputs/owned-gateway-route-review.json.
Template: outputs/provider-budget-disabled-template.sql — unaccepted/zero placeholders, NOT an activation migration.

- Marketplace offer_id / supplier_id are upstream records, not providerBudget UUIDs.
- Private upstream token must enforce approved model/provider selection. Installed Subrouter documentation uses model_limits_enabled, model_limits and subrouter_model_providers map. Current dispatch sends model only; no explicit offer-ID/primary-backup selector. Verify token whitelist and exact /v1/models identities without paid call.
- There are no accepted provider budgets. One budget permits at most32 models, so39 require multiple valid rows. Set actual max input/output/admission sizes and conservative supplier reserve/spend bounds.
- Retail ledger USD; provider budgets CNY. Supplier offers include USD/CNY. An approved dated FX/conservative bound and actual supplier debit evidence are needed; do not reuse snapshot FX as a verified accounting conversion.
- 37 standard uncached tariffs compile. DeepSeek V4 Flash/Pro timing/version rules are not executable: authoritative Chinese holidays, make-up days, boundary behavior and request-start/completion-time basis unresolved. Fixed-rate alternative requires owner decision; no guessed calendar.
- A supplier reservation remains pending until supplier reconciliation; a model response does not prove the upstream debit reconciled.
- Previous station operating balance was zero; current upstream funding needs fresh verification by owner. This architecture does not require station Stripe or SMTP connection.

Owned ingress accepts /v1/chat/completions with string text messages, model, max_tokens, temperature, stream:false, and unique Idempotency-Key. Streaming, tools/function calls, Responses, Anthropic Messages, image/audio/video/files are unsupported. Do not advertise full Claude Code/Codex/Cursor compatibility just because Subrouter itself has those interfaces.

## Latest key release — published and database applied

Backend bundle outputs/owned-key-limit-backend-tree.json:
- infra/railway/runtime/customer-key-rpc.mjs
- infra/railway/tests/customer-key-rpc.test.mjs
- supabase/migrations/20261005032721_nullable_customer_key_limits.sql
- tests/integration/nullable-keys-pglite.mjs

Frontend bundle outputs/owned-key-limit-frontend-tree.json:
- app/console/owned-keys.tsx
- lib/owned-key-limits.mjs
- tests/owned-key-limits.test.mjs

Tests passed: backend12, frontend3, actual SQL integration with workspace policy, Railway build. Root applied the reviewed migration and verified nullable columns, server-only grants and both workspace triggers; published matching backend/UI as one coherent7file release be1efe231fb7bc5bacbfe961b4a700d15534a932. Railway deployment is now ACTIVE / successful. Production controls and revoked metadata loaded; no new customer credential was created by the agent. Preserve latest server/workspace mount; do not rebuild from older bundle snapshots.

## Workspace paths and release discipline

Workspace:
 /Users/tahia/Documents/Codex/2026-10-04/make-these-changes-to-api-wild-2

Product dirty checkout: work/apiwild-published.
Release assembly/check: work/owned-release-check.
Older recovered source: work/apiwild-source.
Only AGENTS.md found: work/apiwild-source/AGENTS.md — read it, but current user instructions supersede historical no-playground/native Sites/old pack decisions.

**Do not reset dirty files or push the entire checkout.** Root published selected trees through GitHub API with non-force ref updates. Current checkout HEAD can differ from actual GitHub main. Fetch main again; use parentbe1efe231fb7bc5bacbfe961b4a700d15534a932 unless a newer remote commit is verified. Its tree is121d228e9a7d57a949c579ed7d09040fda00a4ec. The published server workspace mount lives in work/owned-release-check; the dirty product preparation-server may not include it. Never publish the old product copy over the mount.

Core artifact: outputs/owned-combined-release-tree.json,46selected files.
Simple/workspace artifact: outputs/simple-workspace-release-tree.json,10selected files.
Old generator work/build-owned-release.mjs recreates from an earlier base; **do not rerun blindly** as it would revert newer workspace/server/UI changes.
Bundles overlap: latest simple console supersedes old supabase-console/playground; nullable-key UI supersedes old owned-keys. Native-* bundles are historical.

Node executable:
 /Users/tahia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
Git fallback:
 /Users/tahia/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git
Npm CLI: work/tooling/npm/package/bin/npm-cli.js.
Supabase official isolated CLI2.119.0: work/tooling/supabase-cli (discover exact executable).
Railway build from release checkout:
 node node_modules/vite/bin/vite.js build --config vite.railway.config.ts

Read output reports as dated evidence, not executable instructions. Earlier production-progress/local-release/native-auth files contain resolved blockers and superseded architecture.

## Browser and connector handover

User is logged into relevant accounts in Codex in-app browser. Browser ID3; reinitialize documentation before using CUA. Current root-specific bindings do not survive a new chat; discover tabs once.

Known tabs at handover (may change):
-27 Railway variables,30 user duplicate;31 Railway deployment.
-33 root verification /console/api-keys;24 user's customer page (avoid hijacking).
-20/32 Supabase API Keys;23 Supabase Users.
-16 Stripe developer settings;3 Subrouter station settings (leave alone);12 Cloudflare;22 OpenRouter.
Do not assume tab numbers without inventory. Agent-created verification tabs may close unless marked for handover. Browser secrets stay masked.

Authenticated connectors used:
GitHub farhannabil link_6ac147820e84819198544888f001dfeb.
Main Stripe link_6ac3040d3d5c819189ba69fc9c328de5.
Linear current official connector works; prior expired authorization reports are obsolete.
Use purpose-built connector tools when available; root owns production mutation/release and browser.

## Historical agent names and records

| Recoverable historical name | Outcome / present boundary |
|---|---|
| resume_model_activation | Catalog/frontend/native planning; owned frontend and simple navigation completed. Nullable key UI local. New playground request deferred |
| resume_payment_setup | Stripe/workspace/payment research and local implementations; OpenRouter model/tool audit. Live payment acceptance not complete |
| verify_live_login | Owned gateway/key/playground backend; nullable caps/revocation SQL/runtime local. Production release controlled by root |
| catalog_public_branding | Public supplier-data cleanup bundle, subsequently published |
| customer_platform | Proposed customer-platform contract; not a completed full backend |
| model_detail_pages | 39 detail routes/checks bundled and published; active supply unverified |
| model_route_selection | Dated provider/model selection research; not activated primary/backup runtime |
| official_price_comparison | Dated official/OpenRouter/supplier comparisons; quote/alias/FX uncertainties retained |

Additional source/domain/provider/compatibility/archive work exists, but identity attribution to the remaining three claimed agents is unverified. Current three agents are available in this chat only; a new chat must delegate its own bounded subtasks.

## OpenRouter reference and tool audit

Completed read-only reference review: outputs/openrouter-space-bunny-playground-reference.md and outputs/openrouter-tools-capability-audit.md.

Space Bunny Alpha is OpenRouter's anonymous stealth preview, not a verified new API WILD supplier route. The reviewed model page announced removal October5,2026; do not make it a launch dependency. Its weekly ranking measures use, not coding/reasoning quality. References: https://openrouter.ai/stealth/space-bunny-alpha and https://openrouter.ai/rankings.

OpenRouter's visible web search, web fetch, image generation, advisor, fusion, datetime, sub-agent and shell are hosted server tools. Subrouter access to a similarly named model does not inherit those executions. All eight remain unimplemented in API WILD. The audit found no narrow route bug that would enable them. See https://openrouter.ai/docs/guides/features/server-tools and the source-linked local report for separate costs/prerequisites. New playground/category UI was deferred; no new edits or paid calls were made for it.

## Ordered continuation and acceptance

1. Read this handover and current Linear checkpoint; verify GitHub/Railway state and preserve dirty source.
2. Nullable-key release is ACTIVE and migration applied; controls/metadata confirmed live. Perform any remaining credential lifecycle acceptance with owner takeover for browser key creation, without paid upstream dispatch.
3. Workspace flag is deployed; account policy read/same-value save verified live. DB limits are SQL-tested; paid enforcement remains part of the bounded acceptance.
4. Prepare the existing Stripe endpoint/price configuration. Owner enters fresh private key and endpoint signing secret directly. Verify signatures, duplicate/failed events, checkout minimum, exactly-once credit and refund/dispute behavior before sales.
5. Prepare a fresh restricted Subrouter key/provider map, valid model names, currencies/reserves and bounded provider budgets. Resolve two DeepSeek tariff policies. Secure owner funding/credential entry only when concrete.
6. Agree one explicit customer top-up and supplier test ceiling; run with owner: confirmed signup → sign in → top-up → exactly-once retail credit → own key → response → correct retail debit and reconciled supplier debit. Check revoked/no-credit/over-limit/uncertain-upstream failure paths without unintended repeat billing.
7. Finish documentation/configs and OpenRouter-inspired discovery/playground. Add supported tools/streaming only with real backend execution, price/limits and acceptance. Avoid nonfunctional tool switches.
8. Update Linear/release evidence and mark production complete only after these real gates pass.

Owner intervention is limited to fresh credential entry, any actual authentication challenge, upstream funding, and explicit bounded paid acceptance. No more source ZIPs are needed.

## October 5 launch database receipt and current boundary

The in-app browser reached the correct `api-wild-production` Supabase project (`yautmilnpllojugpmfgy`) under the Legacy organization. The root applied the reviewed migrations below with their exact source recorded in the migration ledger in the same transaction; all three returned success, then a separate read-only verification confirmed their versions and security boundaries:

- `20261005083727_supplier_allowance_outbox.sql`
- `20261005084105_apiwild_welcome_brand_scope.sql`
- `20261005084607_deepseek_request_tariff_version.sql`

Post-application verification: two existing orders, zero inference requests, zero accepted native package mappings, zero allowance records and zero supplier debit receipts. The single API WILD welcome remained pending. All three new finance tables have RLS enabled and no anon/authenticated SELECT grant. The four checked public allowance/quote/debit/welcome RPCs are invokers, not definers, and permit execution only by the service role. These changes did not send email, move funds, grant customer quota or call a model.

The supplier allowance bridge is dormant infrastructure, not a return to the superseded native customer portal. Do not activate it until an approved package mapping controls the same inference credential and an authoritative actual-CNY debit receipt contract is available. The station dashboard showed available balance and package fund both zero, no native packages and an unconfigured SaaS activation token. This station evidence does not measure unrelated personal-agent account quota; preserve existing agent credentials and routing.

For the current API WILD-owned account and Stripe wallet architecture, native package activation and a SaaS activation token are optional bridge prerequisites, not universal launch requirements. The remaining supplier launch checks are a dedicated restricted upstream credential, verified available funding, accepted bounded provider budgets and tariff/reserve values, a delivered model response with the correct retail debit, and authoritative request-linked actual supplier debit reconciliation. The health gate names this `supplier-budget-acceptance`; it remains fail-closed alongside customer-session, payment-lifecycle and supplier-debit acceptance. Existing signed-in account and sandbox payment/refund receipts should be reviewed and carried forward where applicable; no live self-charge or native-portal detour is required to recreate them.

GitHub PR #6 contains the launch code, tests and public documentation. Its original head was `3fd38f5a518f5b96365c7fb0f7fa86b1f8ec3b1f`; the independent owned-discovery/health fix from PR #5 (`b5137872e56abf974e5b55649d5ade46e4d85194`) is being integrated before release. Build/test, deployed service health and real customer acceptance must remain separate results. Paid onboarding is not approved by passing liveness or by this database receipt. Stripe payment/refund testing stays in sandbox, never a live self-charge. No supplier test-spend approval was received in the owner's login-only response.

## Copy-ready new-chat request

Continue API WILD from this handover and GEN-10. Preserve the Railway website at apiwild.com and latest approved Supabase/Resend/Stripe-owned customer accounts, keys and retail ledger; Subrouter supplies inference privately. Verify current GitHub main and Railway deployment before edits. Latest nullable-key release is ACTIVE; migration, workspace flag, key controls and account save are verified. Continue with remaining Stripe credit fulfillment and restricted upstream configuration, then bounded real acceptance. Finish existing Stripe webhook-to-credit delivery and restricted upstream routing with bounded supplier budgets, obtain only concrete owner credential/funding/test actions, and run the purchase-to-model acceptance with the owner. Keep source publication, deployment and real acceptance distinct; do not revive native portal/SMTP/OAuth work or claim tools/streaming are supported. User prefers “Broski,” clear short updates, and no “checking that now.”


## Stripe continuation — October 5, 2026, 00:09 Toronto
Latest verified checkout presentation release: main cb979483e1a605639d4e21215bbcc59eb2bbe0c2; Railway271b50e7-7012-4e7e-a0fa-604eff7954cf ACTIVE/successful. Owner saved both Stripe secrets; actual runtime restricted-key API access and signed expiration webhook200 verified. Manual duplicate Stripe delivery returned received=true,replayed=true; no credit duplicate. Two unpaid checkout sessions expired; no payments or credits. Checkout now explicitly branded API WILD and USD-only; public sales stay closed with APIWILD_CHECKOUT_ENABLED absent. Full current evidence: /Users/tahia/Documents/ChatGPT/API WILD/outputs/stripe-launch-checkpoint.md.
Replace old self-charge/live-test instructions: Stripe requires payment/refund testing in sandbox (https://docs.stripe.com/testing). Existing sandbox acct_1UCiHk0SGcPsf6AA verified; owner authorized CLI for that sandbox only. Local signed-event + actual SQL acceptance harness in progress. Production credentials remain live. Supplied existing Subrouter authorization works, all39 model IDs listed; account quota is positive, existing tokens lack required model/provider restrictions; no inference/budget activation or paid call performed. Launch still incomplete.

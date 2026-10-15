# API WILD current handoff

## October 12 pricing correction

Pricing now estimates API WILD retail input/output usage for currently callable models, with the same integer micro-dollar rounding as the server. The old OpenRouter reference calculator is removed from the pricing page. Existing customer retail rates, prepaid credit offers, model exclusions, supplier budgets and uncertain financial records are preserved.

Five private supplier quote entries were refreshed from current exact supplier marketplace offers and corroborating native receipt tariff fields. Quote conversion uses the pinned supplier wallet setting CNY 6.8 per USD. Three models require higher conservative per-request supplier reservations within the unchanged approved global budget; stage and verify those before deploying the corrected catalogue. Full private audit/report and before/after reservation evidence are in the workspace `work/apiwild-pricing-20261012`, outside the published source. Paid acceptance was not rerun.

Source baseline: https://apiwild.com → https://github.com/farhannabil/api-wild → production b86d8406a18a0131a39512d3a9d5fea5fb915a62 → Linear GEN-10 → owner Farhan. The pricing correction release requires its own exact deployment/CI receipt before calling it live.

Read [API_WILD_HANDOVER.md](API_WILD_HANDOVER.md) first for the latest checkpoint, architecture, verified release/database evidence, launch blockers and remaining acceptance tests. Fetch GitHub main before source changes; concurrent customer billing work is active.

For personal Codex on Windows, read [CODEX_SUBROUTER_WINDOWS_HANDOVER.md](CODEX_SUBROUTER_WINDOWS_HANDOVER.md) and the [Subrouter connection ticket](https://linear.app/genxintel/issue/GEN-31/verify-subrouter-powered-codex-desktop-and-manual-subscription). Passing CLI probes is not desktop activation evidence. VPS continuity is requested but not installed.

API WILD owns Supabase accounts, Resend emails, Stripe retail credits and customer keys; Subrouter supplies upstream inference. The native station portal work is superseded. Production payment-to-model acceptance remains unfinished.

## October 5 owned-runtime CI repair

The Railway runtime now mounts retail-only public model/config discovery and authenticated account, key-model and key-usage reads. The health workflow waits for its exact main commit to appear in runtime metadata before verifying routes and access controls. Manual feature-branch runs do not probe production. The legacy Cloudflare D1/AARO maintenance mutation is removed from this read-only monitor; owned Supabase finance sweeping and paid launch acceptance remain open under GEN-10. Keep the separate active launch checkout and its allowance/docs changes intact.

Validation before publishing: Railway Vite build completed; all 350 top-level tests passed; focused discovery, gateway authentication, assembly and health tests passed. Public model availability reports configured capabilities only, not verified supplier funding. A successful health run is not evidence of payment-to-inference acceptance.


## Six-model catalogue and pricing expansion, 2026-10-13

Prepared six owner-selected USD reference tariffs per million input/output tokens: GPT 6 Astra5/25, GPT6Sol1/5, GLM5.3 1/2.25, Sonnet5.5 1/5, Gemini3.8Flash0.5/1.75, DeepSeekV4.1Flash peak0.15/0.76 and offpeak0.09/0.35. Public approved catalogue22; private retained catalogue40 with historical supplier and tariff snapshots. Actual billing follows the newer supplier-cost5x policy from PR35; preserve its prospective activation, immutable old records and zero extra fee.

All six produced real paid supplier responses through isolated test-mode customer keys; original retail-debit arithmetic, replay and immutable native wallet receipts verified before cost5 activation. Native tariff SQL tests use isolated rollback fixtures; no production customer funding changed. Failed Gemini timeout and two DeepSeek validation requests remain held. Test supplier allowance cap was not increased and test keys were revoked. Private journals and USD comparison are under workspace work/apiwild-provider-review-20261012, outside published source.

The reviewed a6aa DeepSeek alias reports an auxiliary cache-derived total inconsistent with the wallet-metered input/output pair. Acceptance requires the exact alias/model/supplier, valid immutable request identity and an explained auxiliary total; other routes remain strict. Public customer totals use the validated input/output pair; original supplier total remains private audit evidence.

Release/configuration verification is recorded in the final checkpoint; source preparation and paid sandbox checks do not prove a new live customer purchase.

## Customer credits console — October 12 local / October 13 UTC

Direct promo redemption uses a private campaign table, locked global cap and unique customer redemption. Wallet funding, immutable redemption and credit-email queue are one transaction. No Stripe call for promo. New card-credit ledger trigger queues confirmation only on actual positive checkout funding. Email worker uses fixed Resend idempotency keys, durable leases, bounded retry window and no secret logs. API-key labels are separate owner-scoped metadata and do not change upstream key identity.

Usage explorer adds model input/output/cache totals and latest50 safe owner-scoped activity rows, preserving unknown cache and historical charges. Manual refresh also refreshes charts. Source/UI tests452, focused runtime22, PostgreSQL9groups, TypeScript and Railway build passed. Two independent reviews completed; active final email lease and ambiguous billing response corrected.

Supabase20261013040000/20261013040100 applied after production rollback acceptance. No campaigns or credits created by migration. Owner-approved private campaign is400USD, one redemption globally,48hours from activation after UI release. Production before release e3f26095149f12945c69671e9e774645a3c9208a. Deployment and actual email delivery remain pending at this source checkpoint. No paid test or real promo redemption.

### Customer-credit console live acceptance — 2026-10-13 01:06 UTC

PR39 merged659a206b2cb3b334af7fe18d20a79a57d00d8231; Railway52fd6063-433f-40cd-b5df-e1abbca96d04SUCCESS; readiness200exactSHAreadytrue,0blockers. All3mainCI38330194091/38330194054/38330194014SUCCESS. Authenticated browser verifies promoform,19modeldetails/24requestactivity/search, and persisted label on revoked setupkey. Anonymousnewaccountendpoints401. Launchcampaign400USD,max1globally,unused; activated2026-10-13T01:04:49.682884Z/expires2026-10-15T01:04:49.682884Z. Privatecode deliberatelyexcludedfromGit. No paidprobe/redemption/emailtest. Emailqueue/worker configured andmockverified; customerinboxdelivery awaitingrealcreditgrant. Actualkeylabelacceptance affects onlyownerrevokedsetupfixture. Screenshots private releasefolder. ExistinghistoricaldirtyHANDOFF preserved in stash preserved-hourly-handoff and private HANDOFF-before-console.md.

### Auditable usage page + native quota-delta reconciliation — 2026-10-15 01:59 UTC

Owner fix plan 2026-10-14 late evening (key 401, 5x live sync, auditable usage page). Branch feat/whitelabel-x5-hardfund-20261014 off main7755b1d. NOT committed/pushed/deployed at this checkpoint.

Backend native-usage-sync.mjs: hourly reconciliation no longer stops the customer token or zeroes remain_quota for routine syncs. Imports logs with token live, then delta-adjusts remain_quota = nativeAllowance(available/5) minus quota consumed since pass-start baseline (schema has no persisted allocation baseline; pass-start used_quota documented). Bounded 3x read/update/readback retry on in-flight usage races. Stopped-but-funded tokens are re-enabled with verified status/expiry/quota readback (fixes top-up recovery and repairs abort-killed keys on the next pass); revoked/expired/out-of-funds paths still stop. Fail-closed codes kept: unbound_token_used, native_log_invalid, native_log_cursor_invalid, native_log_scan_incomplete, native_allowance_unconfirmed. No SQL/RPC/migration change.

Frontend: usage-activity.tsx gains Rate charged column (approved catalogue apiwild_selling_price, all 22 models approved USD per-million) plus ledger blended cross-check per model and per request; headline model ordering with visible expandable Other (n models) rollup (nothing hidden, search still finds all); CSV export (time, model, state, tokens, cache, charged USD, effective rate) client-side from the existing /api/usage/details payload. usage-charts.tsx states the exact rule (supplier USD x5, zero fee, integer micros round-up, 500000 quota=$1 supplier=$5 customer) and per-lane lag (native hourly import; gateway hold immediately, settle ~1min). native-console.tsx CRITICAL correction: Available credit, Total usage, key Remaining budget and per-request Recorded cost previously displayed supplier USD (1/5 of the real charge); now customer USD x5 with explicit rule text; logStats RPM/TPM surfaced. pricing.tsx labels catalogue values rate charged vs OpenRouter/official list comparison.

Verification: build exit0 (vinext via node direct; GNU timeout->.bin shim exec blocked by missing Git usr/bin/sh.exe on this machine, unrelated to code), root suite450/450, CI apiwild.yml runtime files461/461 (44 files), native hourly25/25, usage-rates2/2. Evidence .claude/it-team-evidence/be-quota-delta.json + fe-audit-rates.json. tsc --noEmit not separately run (hosting.json stub now generated by scripts/prepare-ci.mjs; build covers type pipeline). Not claimed: production deployment, paid inference end-to-end, live customer receipt of the new pages.

Owner actions still open: re-issue or repair the dead sk- key in the station console (enabled, non-zero quota, bound); GET /v1/models liveness gate before inference; deploy decision for this branch; native import interval (3600000ms) unchanged pending owner freshness decision.

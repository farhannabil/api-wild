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

# Conditional DeepSeek tariff gate

- Source implementation only, checked 2026-10-05. No route, rate acceptance, supplier funds, native key, or paid test is enabled by this change. The default retail runtime still has 37 standard tariffs. The two conditional tariffs require every gate below; 39 catalog models does not mean 39 callable models.
- The API WILD retail policy is **admission time**: a server clock selects the tier before the first reservation, and `gateway_requests.rate_version` stores the immutable full version. This is an explicit owner-accepted retail rule. The official maker documentation does not establish which instant the intermediary uses to debit its native balance.

## Verified primary sources

- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) and [Chinese pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/): peak intervals are 01:00–04:00 and 06:00–10:00 UTC on Monday–Friday excluding Chinese public holidays. These are 09:00–12:00 and 14:00–18:00 Beijing time. Boundaries use start-inclusive/end-exclusive intervals. All weekends are off-peak, including government-designated makeup working weekends.
- [DeepSeek updates](https://api-docs.deepseek.com/updates/): the verified served version of `deepseek-v4-flash` is `DeepSeek-V4.1-Flash`; `deepseek-v4-pro` retains `DeepSeek-V4-Pro-0813`. The current update supersedes the older notice of Pro migration. The owner must separately verify that the selected intermediary serves this exact version; maker documentation alone is not intermediary acceptance.
- [State Council 2026 holiday notice, 2025/7](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm), also verified through the [official traditional-Chinese mirror](https://big5.www.gov.cn/gate/big5/www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm): January 1–3, February 15–23, April 4–6, May 1–5, June 19–21, September 25–27, and October 1–7. No 2027 calendar is guessed.
- Source identifier: `deepseek-pricing-2026-10-05`. Calendar identifier: `cn-state-council-2026-7`. An accepted price window lasts no more than seven days, cannot begin before the source check, and cannot extend beyond the verified Beijing 2026 calendar. Expiry blocks new admission and dispatch. Revalidation is a deliberate owner operation; there is no automatic renewal.

## Required trusted inputs

1. Apply and verify the reviewed migration `20261005084607_deepseek_request_tariff_version.sql` through the authorized database workflow. It preserves the installed reserve/claim definitions and changes only their provider-budget version comparisons; unexpected definitions abort the entire migration. Compare live definitions first because historical local and deployed migration identifiers differ. Never apply this migration by assuming the local filename proves the live schema version.
2. Keep each accepted provider budget at the base `APIWILD_RETAIL_RATE_VERSION`. Requests for exactly the two named DeepSeek models use `<base>:ds26:peak` or `<base>:ds26:off_peak`. Standard models keep exact base-version matching. Malformed, foreign-model, unknown-tier and unknown-base suffixes fail closed.
3. Supply an owner-reviewed `APIWILD_DEEPSEEK_TARIFF_POLICY_JSON` object with: `accepted: true`, `billingBasis: "apiwild_admission_time"`, `baseRateVersion` matching the existing retail version, the exact source/calendar identifiers above, ISO UTC `validFrom` and `validUntil` including milliseconds, and `servedVersions` containing the verified model/version pairs. A subset of the two models is allowed. Unsupported versions are rejected. Never accept a customer/browser tier, clock, or policy.
4. Supply `APIWILD_DEEPSEEK_SUPPLIER_RATES_JSON` keyed by exact model and supplier role (`primary` or `backup`). Each configured role needs `accepted: true`, the exact selected `supplierSlug` and native `currency`, and explicit `off_peak` and `peak` objects, each with `input` and `output` prices per million tokens. Do not infer an intermediary multiplier from maker or retail prices. Unknown roles and unknown model fields are not valid acceptance evidence. An actual supplier CNY receipt is still required later to settle native liability.
5. Verify the route, exact served model, native inference credential identity, accepted budget, conservative input bound and supplier CNY reserve. If execution can cross a peak boundary, the reservation uses the larger verified supplier input/output component ceilings across that window. API WILD retail remains at its admission tier. Missing or insufficient supplier quotes block before reservation/dispatch.
6. Only after these reviews may the owner set `APIWILD_DEEPSEEK_TARIFF_ENABLED=true` together with the separately authorized inference gates. The new flag alone cannot create supplier funds, packages, mapping, routes, or credentials.

## Replay and native settlement

- Before clock selection for a DeepSeek request, the service-only quote lookup checks the verified owner, exact customer-key ID (including null), request key, payload hash, capability and model. A match returns only the immutable reservation quote. A mismatch is HTTP 409; unknown requests do not create records. Customer result contents and supplier details are absent from this DTO.
- The normal reserve/recovery flow validates that quote again. An existing request is never redispatched, including held/uncertain work. A settled replay can be recovered after the tariff window expires without calculating a new price. Current owner/key/provider gates remain effective.
- Full version and payload hash remain immutable. A race between two first admissions at a tier boundary can yield a safe 409; it cannot authorize a second dispatch under the same request key.
- Supplier reconciliation remains pending after token-based retail settlement. An estimated cost or user-log entry lacking actual CNY is not a final native debit receipt. The fixed shared-business upstream transport has not been changed to the station endpoint, and customer-native allowance identity remains an independent acceptance gate.

## Local verification

1. From the isolated checkout, run:

   ```powershell
   node --test infra/railway/tests/deepseek-tier-policy.test.mjs infra/railway/tests/deepseek-assembly.test.mjs infra/railway/tests/gateway-quote-lookup.test.mjs infra/railway/tests/retail-token-pricing.test.mjs infra/railway/tests/model-accounting.test.mjs infra/railway/tests/owned-gateway-assembly.test.mjs infra/railway/tests/supabase-gateway-rpc.test.mjs
   ```

2. With the already isolated pinned PGlite 0.5.8 package (outside this repository), run:

   ```powershell
   node infra/railway/tests/deepseek-tariff-postgres.mjs 'C:/Users/farha/AppData/Local/Temp/apiwild-launch-pglite-20261005/node_modules/@electric-sql/pglite/dist/index.js'
   ```

- These checks use synthetic credentials, prices, customers, HTTP responses and a local in-memory database. They prove calendar boundaries, immutable retail charging, replay isolation and SQL controls. They do not prove a live supplier tariff, independent-connection concurrency, native debit, production deployment or customer acceptance.

# API WILD — Railway source snapshot

- Source: local `commerce-billing-release` checkpoint `e064879a2730c9a3ad4149916a9846bce7d943b2`; application catalogue commit `3748fc9661d06e98d00e6f9992249063c74aaa47`, with a tested Docker catalogue-inclusion fix.
- This GitHub export excludes private plans, deployment notes, credentials and original Sites identity. Original source and history remain on the owner's Windows computer.
- Railway build: `Dockerfile.railway`. Required catalogue and dependency lockfiles are included. The informational catalogue is not a guarantee of customer-callable models.
- Local setup: Node 24; `npm ci --ignore-scripts --no-audit --no-fund`; `node scripts/prepare-ci.mjs`; `node node_modules/vite/bin/vite.js build --config vite.railway.config.ts`.
- For offline tests, run the `.test.mjs` files in `tests`, `infra/railway` and `infra/railway/tests`, excluding `aaro-usage-postgres.test.mjs`, which requires a separately isolated Postgres fixture. Use test concurrency 2.
- Keep `BILLING_ENABLED`, `COMMERCE_READY` and other customer-execution gates closed until genuine customer, email, financial and provider acceptance passes. Never commit runtime keys.
- Publishing this source does not redeploy Railway, move domains or certify production readiness. Linear tracking: GEN-10.

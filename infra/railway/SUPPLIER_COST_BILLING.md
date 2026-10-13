# Supplier cost billing

Customer deductions are actual verified supplier USD cost multiplied by five. Extra fees are zero. Native Subrouter quota is 500000 units per supplier dollar, so each quota unit deducts exactly 10 customer USD micros. Do not calculate the final USD debit from rounded CNY amounts.

Model sheet numbers remain reference prices. The console and pricing pages disclose the actual billing rule. Existing imported receipts and pre-activation gateway reservations keep their original charges. Delayed native receipts use their supplier creation timestamp to select the policy.

## Release order

1. Apply `20261013010000_supplier_cost_five_times.sql`. It starts inactive. The asserted patches support both the original native importer and the newer tariff helper, preserving the historical calculation and rate version.
2. Deploy the compatible runtime and verify its exact commit and worker health.
3. Set the policy's previously null `effective_at` to a whole-second UTC timestamp. Activation is immutable. Never rerun an older native-import replacement over this migration.

Native keys retain finite hourly allowances backed by wallet reservations and the existing shared provider budget. The worker pauses a key, imports receipts idempotently, checks its cumulative usage, then allocates against available credit. The new maximum $1 customer reservation permits at most $0.20 supplier spend; it does not increase the shared supplier budget.

Gateway responses retain their full USD reservation until verified supplier reconciliation. Both billing and usage subtract those pending holds. A verified failed supplier call is also charged at five times its actual cost; historical failures retain their old treatment. Missing evidence remains pending. A charge above the reserved bound retains the hold and freezes the provider for review.

## Verification

`tests/integration/supplier-cost-five-pglite.mjs` verifies inactive policy and grants, immutable activation, historical treatment, native cutoff, exact small-unit rounding, zero usage, duplicate/conflicting receipts, pending holds, expiry, failed calls, both overrun paths and the $25 - ($1 x 5) = $20 example. The production-schema acceptance SQL is a rollback-only fixture for use before activation.

Production rollback acceptance passed on 2026-10-13 UTC, including the newer native tariff helper. No external inference call or real customer debit was made by that test. Successful schema tests and deployment health do not establish a paid customer's end-to-end acceptance.

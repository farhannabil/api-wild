# Reviewed release acceptance

- `infra/railway/release/release-acceptance.json` is initially **unaccepted**. Enable flags, local fixture tests, a direct supplier call, missing files or hash-shaped strings alone cannot open readiness.
- Root supplies owner-approved checkpoints from actual observations after the genuine customer sandbox lifecycle completes. This records **sandbox payment acceptance plus verified live configuration**, never a completed live customer purchase.
- The fixed release directory is included privately in the server image, outside the public asset roots. Only the manifest and four exact checkpoint filenames are allowed. No raw secrets, customer content, IDs or costs are needed in these files; use SHA256 digests of retained original evidence instead.

## Manifest

- Exact fields: `schemaVersion:1`, `status:"accepted"`, `version`, `issuedAt`, `validUntil`, `acceptedModels`, `conversionSha256`, `checkpoints`.
- `version` must equal configured `APIWILD_RETAIL_RATE_VERSION`. Timestamps must use UTC ISO format. Issue time cannot be in the future; expiry must be within30 days and cannot exceed the accepted supplier conversion expiry.
- `acceptedModels` must be the exact unique configured route model set (at most39). Both the set and its actual current discovery availability are checked; expired conditional models close readiness.
- `conversionSha256` must equal the existing approved supplier settings digest. `checkpoints` maps each gate name below to SHA256 of that exact checkpoint file's bytes. Do not normalize or reformat a checkpoint after hashing it.

## Checkpoints

Each `<gate>.json` has exactly: `schemaVersion:1`, `gate`, `status:"passed"`, `ownerApproved:true`, `observedAt`, `scope`, `checks`, `referenceDigests`. The observation must precede issue time by no more than7 days. `referenceDigests` contains1–20 unique SHA256 digests of retained actual supporting evidence; static assertions without that evidence are not acceptance.

| Gate / filename stem | Scope | Required true checks |
| --- | --- | --- |
| customer-session-acceptance | production-configuration | productionLogin, ownedDashboard, ownerIsolation |
| payment-lifecycle-acceptance | sandbox-lifecycle-and-live-configuration | sandboxPayment, signedWebhookCredit, retailDebit, idempotentReplay, refundReversal, testKeyRevoked, liveConfiguration |
| supplier-budget-acceptance | production-configuration | restrictedProductKey, finiteSharedBudget, modelProviderBindings, noAutomaticTopup, approvedExpiry |
| supplier-debit-acceptance | genuine-customer-sandbox-request | customerRequestMatched, actualWalletDebit, normalizedCostAudited, holdReconciled, backgroundReconciliation |

- `backgroundReconciliation` requires actual configured worker observation. A fixture test or successful manual receipt operator does not establish that checkpoint by itself.
- The loader hashes and parses all four bounded files. It rejects unknown/missing fields, altered file content, wrong gate/scope/status, missing checks, absent source references, reused checkpoint hashes, symlinks, oversized files and mismatched configuration. Original referenced evidence stays in the owner-controlled evidence store; the runtime verifies its reviewed checkpoint digests, not external Stripe/provider history on every health request.
- Accepted artifacts are a reviewed operator input. They are not a digital signature and cannot defend against an authorized source/deployment owner intentionally replacing both the checkpoint and its digest. Review the actual originals before accepting them.

## Runtime checks

- Startup reads the fixed files. A plain forged object cannot replace the branded loader result.
- Every health request rechecks the clock, accepted model set/current availability, live billing mode, enabled background reconciler, pinned conversion identity/expiry, account/billing/inference/checkout configuration and valid deployment commit.
- `/health/ready` becomes200 only when all checks pass; otherwise503. `/health/live` remains200 with a coherent readiness/phase pair. The health script accepts both coherent states and still independently requires the readiness contract.
- Public status discloses only acceptance recorded/not-recorded, accepted model count and expiry alongside existing configuration checks. It never includes checkpoint digests, supplier details, private identifiers or amounts.
- Local preview cannot load launch acceptance or start background financial work.

## Release procedure

1. Finish actual acceptance and keep the original evidence. Leave the manifest unaccepted while any gate remains open.
2. Create the four sanitized checkpoints, review their sources, hash their exact bytes, then prepare the manifest using the approved route/conversion/version settings.
3. Independently review the artifacts and commit them with the release. Deploy through the existing authorized path.
4. Verify `/health/ready`, exact deployed commit, public model availability and the normal operational health workflow. An accepted record does not waive other checks.
5. Renew only with a reviewed fresh record. Expiry or configuration changes automatically restore503; do not extend timestamps to conceal an unverified change.

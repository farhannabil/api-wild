# API WILD autonomous maintenance

- Host: Hostinger KVM4, VPS1993150, dedicated non-root `apiwild-maintenance` account (UID999).
- Existing Paperclip company: `5b74ebc7-db43-4476-a25c-7d2052881444`. Tracking parent: FAR-59 (`2d436f81-a440-4cad-b541-98b0a8e21e24`).
- The customer site remains on Railway at `https://apiwild.com`. This installation moves the maintenance control plane, not the site, DNS or customer database.
- Linux kernel guard acceptance has passed. Native model acceptance remains pending; runtime health does not establish that acceptance.

## Services and private paths

- `apiwild-paperclip.service` runs the existing manager with its database, agents, history and budgets preserved. Paperclip listens privately on loopback port3100.
- `apiwild-maintenance.timer` starts the bounded `apiwild-maintenance.service` every five minutes. Source and exact-commit CI checks run hourly or when main changes.
- Operator code/state: `/srv/apiwild-maintenance/operator`. Clean monitor: `/srv/apiwild-maintenance/monitor`. Worktrees: `/srv/apiwild-maintenance/incidents/<UUID>`.
- Claude HOME: `/srv/apiwild-maintenance/user`; native state: `/srv/apiwild-maintenance/user/.paperclip/instances/default`. Guard/hook/helper: `/srv/apiwild-maintenance/guard`.
- Credential files stay private, outside worktrees, receipts and logs.
- The service template keeps `HEARTBEAT_SCHEDULER_ENABLED=false` during staging. Enable native scheduling in the installed configuration only after sole-manager ownership and native acceptance pass.

## Repair and release flow

1. Healthy scans invoke no model. Two consecutive matching failures create one isolated incident and native backend task.
2. The backend makes a minimal source repair; the existing manager independently reviews the unchanged source digest.
3. The operator validates native run/issue links, strict four-field final JSON attestations and actual product tests. Canonical receipts preserve provenance; agents do not write protected receipts.
4. The operator pushes the reviewed branch and opens a PR. Merge requires unchanged main and exact-head success for `build-and-test` and `guarded-node-build`.
5. Close an incident only after the exact merged commit is public, both main workflows pass and production health passes.
6. Preserve failed/ambiguous attempts and consumed intents. Healthy scans stay quiet; meaningful blockers and completed repairs are recorded on FAR-59.

## Ownership and authority

- Windows marker: `C:/Users/farha/.claude/it-team/paperclip-host-ownership.json`, with `{"activeHost":"hostinger-kvm4"}` after cutover. Local startup/watchdog respect it; the Windows maintenance schedule remains disabled while VPS ownership is active.
- Missing marker retains legacy Windows behavior. Invalid/unreadable metadata blocks local Paperclip startup. OpenClaw remains independently observed; `managed-remotely` does not claim remote health or inference readiness.
- Allow at most two new incidents per UTC day and two occupied native workers. Preserve existing provider/model routes, monthly budgets, supplier ceilings, approvals, consumed intents and failure history.
- Checks do not charge customers, grant credits, run supplier inference tests, retrieve product secrets, change models/prices/packages, migrate databases or top up accounts. Payment/authentication source repairs require independent review and CI.
- Existing GitHub authentication reaches only trusted operator Git/GitHub children. Model and test children receive no GitHub credential. Preserve the approved provider helper and route.

## Verification and limits

- The fixed Linux product verifier passed 127 offline tests across 11 modules. Workers may reach only their own ephemeral loopback fixtures; external network, other local services, subprocess exports and reads outside the checkout/preload are refused.
- One synthetic child-process clock fixture runs in full CI only.
- Actual Linux tests passed two occupied slots, refusal of a third, durable replay refusal, timeout termination and crash-descendant cleanup.
- Same-user guardrails are not an OS sandbox or supplier billing meter. An admitted service can continue until its fixed deadline after outer-adapter disconnect; its slot and consumed intent prevent replacement/replay.

## Owner controls and rollback

1. Pause new ticks: `sudo systemctl stop apiwild-maintenance.timer`. Keep paused after reboot: `sudo systemctl disable apiwild-maintenance.timer`. An already admitted attempt retains its deadline.
2. Set operator `config.json` `enabled` to `false` to prevent dispatch by subsequent ticks. Preserve all journals and intents.
3. Inspect operator `last-job.json`, `state.json`, `incidents/<UUID>.json`, native history and FAR-59. Never replay an ambiguous paid attempt.
4. Resume only after ownership checks: `sudo systemctl enable --now apiwild-maintenance.timer`.
5. To move back, stop dispatch and both managers; preserve and restore the latest verified VPS database/state backup. Do not start an old Windows database blindly. Update Windows paths/settings and select `{"activeHost":"windows-local"}` only after current-state restoration; enable exactly one manager/schedule.
6. Revert product changes through a reviewed PR. Do not delete customer history, receipts, native runs or consumed intents.


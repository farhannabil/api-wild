# API WILD autonomous maintenance

The owner authorized this automation on October 5, 2026. Native Paperclip company
`5b74ebc7-db43-4476-a25c-7d2052881444` remains the sole agent manager.
Tracking parent: `FAR-59` (`2d436f81-a440-4cad-b541-98b0a8e21e24`).

## Schedule and operation

- Windows task: `Farhan-APIWILD-Autonomous-Maintenance`, every five minutes.
- Each tick checks public pages, authentication boundaries, model availability,
  launch readiness and support DNS using the existing daily-health contract.
- Every hour, and whenever main changes, inspect main's JSON and exact-commit CI.
- Healthy scans invoke no model. Two matching failures create one isolated
  maintenance incident and native backend task. The same failed attempt is never
  replayed automatically.
- Native backend makes a minimal source repair. Existing manager independently
  reviews the unchanged source digest. The operator verifies both native run/issue
  links, strict final JSON attestations and real product tests. The operator writes
  canonical receipts after these checks; agents do not write protected files.
- The controller pushes the isolated branch, opens a PR, waits for exact-head
  `build-and-test` and `guarded-node-build`, and merges only if main is unchanged.
- It closes the incident only after the exact merged commit is public, both main
  workflows pass and production health passes.
- Operational changes, blocked repairs and resolved incidents are recorded on
  the native parent. Healthy checks do not generate board notifications.

## Installation on the current host

The reviewed controller, policy, preload and job entry are copied to
`C:/Users/farha/.claude/it-team/apiwild-autonomy`. The fixed agent verification
entry is `C:/Users/farha/.claude/scripts/apiwild-maintenance-controller.mjs`.
Config, durable observations, deduplication, incident journals, receipts and
the latest job result live outside the repository in that operator directory.
The clean monitor checkout is `work/apiwild-autonomy-monitor-20261005`;
each repair uses its own `work/apiwild-autonomous-incidents/<UUID>` worktree.

The standalone Windows job reuses the existing authorized GitHub login through
a per-user DPAPI encrypted credential reference outside the repository. Only
trusted GitHub/Git child processes receive authentication in memory. Test
subprocesses and repair/review agents receive no GitHub credential. Missing or
revoked authentication produces a failed job and an owner-visible blocker.

The independent manager receives a hash-bound, read-only JSON file containing
each source file's before/after contents. It cannot edit the repair. Native tasks
use the installed one-attempt guardian's `maintenance-repair-v1`
and `maintenance-review-v1` profiles and the user-level scope hook. They retain
the existing Claude model, native monthly budgets and permissions. `--setting-sources
user` prevents a repository setting from replacing the installed hook. New task
approvals expire after six hours; consumed intents and historical failures remain.

The host must be awake and the Windows user session available. Task registration
uses `IgnoreNew`, starts missed checks when available, and allows battery operation.
It does not purchase or move hosting, or provide a laptop-off cloud worker.

## Verification and limits

The fixed product check runs 127 offline tests across 11 modules with injected
fixtures and only loopback listeners created by those fixtures with port zero.
Other local services, including Paperclip itself, cannot be called by test code.
Credentials are not inherited by test subprocesses;
filesystem reads are restricted to the checkout and trusted preload. External
network/subprocess exports are blocked inside test workers. One synthetic
child-process clock fixture runs in full GitHub CI only. These same-user guards
are not an OS sandbox against deliberately hostile repository code.

At most two new incidents per UTC day and at most two occupied native workers
are allowed. Existing agent monthly caps stay unchanged. No customer charge,
credit grant, paid supplier inference, secret retrieval, database migration,
package/price/model-route change or automatic top-up is performed by the checker.
Technical repairs in payment/authentication source still require independent
review and the full CI checks. A failed/ambiguous run, changed base, failed review,
exhausted budget or failed release is preserved and reported; no manufactured
passing receipt or unconditional production push is permitted.

## Owner controls

1. Pause: set operator `config.json` `enabled` to false, or disable only
   `Farhan-APIWILD-Autonomous-Maintenance` in Windows Task Scheduler.
2. Inspect: read `last-job.json`, `state.json`, `incidents/<UUID>.json` and FAR-59.
3. Roll back a source repair with a new reviewed revert PR. Preserve incident
   history, task manifests, consumed intents and customer financial holds.
4. Update controller policy deliberately and reinstall reviewed source. A repair
   agent cannot edit its own scheduler, workflow, credentials or policy.

Registration script: `register-task.ps1`; existing service and queue watchdog
tasks are preserved. This is a Windows cron equivalent managed through native
Paperclip tasks, not a Codex recurring automation or an unsupported native routine.

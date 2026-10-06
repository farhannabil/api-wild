# API WILD Linux maintenance guardian

- Staged implementation only. Windows guardian/hooks are untouched.
- Fixed company and existing backend/reviewer IDs; only the two maintenance profiles are admitted. Old inventory/review queues are refused.
- Exact root: `/srv/apiwild-maintenance/incidents/<lowercase UUID>`.
- Operator state: `/srv/apiwild-maintenance/operator`; Claude HOME: `/srv/apiwild-maintenance/user`.
- Native generated MCP/prompt cache: `/srv/apiwild-maintenance/user/.paperclip/instances/default`.
- Verifier: `node /srv/apiwild-maintenance/operator/agent-entry.mjs verify-current`.
- Executables: `/usr/local/bin/node`, `/usr/local/bin/claude`, `/usr/bin/systemd-run`, `/usr/bin/systemctl`. All pinned paths must resolve to regular, non-symlink files with trusted ownership and no group/other write permissions.
- Use the dedicated non-root `apiwild-maintenance` account. Root confirmed its UID999, but this staged code has not inspected the VPS.

## Installation contract for the owner lane

1. Install `policy.mjs`, `guardian.mjs`, and `scope-hook.mjs` at `/srv/apiwild-maintenance/guard/`. Preserve LF shebang, make only guardian executable, and keep the files outside product worktrees.
2. Prepare trusted operator directories `guard-state/` and `run-auth/`, plus `jobs.tsv` with only eight-column Linux maintenance rows. Copy consumed task intent markers before cutover; do not replay Windows jobs. Historical work/receipts stay preserved.
3. Prepare operator-only `provider-context.json` with `homeContextApproved: true`, `approvedHomeKind: "api-key-helper"` (the current approved route), and `approvedEnvKeys: []` if the existing user settings supply the approved helper/base. If forwarding existing approved provider environment variables, list only their exact names and include their exact `approvedBaseURL`. Do not place provider keys in this metadata file.
4. Configure the verified existing user `.claude/settings.json` hook command to run `node /srv/apiwild-maintenance/guard/scope-hook.mjs`. Every admitted child requires `--setting-sources user`. Preserve the approved provider helper/model/route; this guardian does not provision or switch them.
5. Keep user systemd manager/linger available. The fixed slot0/slot1 transient services use `KillMode=control-group`, `Restart=no`, and manifest-bounded `RuntimeMaxSec`. The launcher fails closed without Linux/non-root identity, pinned binaries, user bus, expected cgroup, or authority files.
6. Fixed verifier loads `operator/run-auth/<validated run UUID>.json`: `apiKey`, `runId`, `companyId`, `agentId`, `taskId`, `pid`, `createdAt`, `expiresAt` (plus version1). It must check0600, same UID, regular non-link file, live guardian PID in its ancestry, timestamps/expiry <=240seconds, and actual authenticated native agent/run/issue links. No token is passed in Claude environment or systemd arguments.
7. Normal service exit removes its private auth record. Crash-stale records must be ignored after expiry/dead PID and cleaned during owner-controlled startup; the consumed intent is never removed. The token crosses into the service only through private stdin, then only the original prompt is forwarded to Claude.
8. Root must independently verify actual Linux cgroup cleanup, slot contention, guard hard-kill, expiry, and intent replay refusal with a fake child before native agent acceptance. Enable only one maintenance controller after Windows schedules are disabled and ownership/budget/state migration passes.

## Evidence and limits

- `node --test guard/guard.test.mjs` exercises exact identity/manifest/argv/paths, MCP/prompt bounds, secret isolation, immutable intents, both roles, symlink/private-path refusal, and fixed systemd properties.
- Unit path fixtures simulate POSIX realpaths on Windows. The intent test performs real exclusive file creation and file fsync; its Windows directory-fsync facade checks the call, not the Linux kernel behavior.
- Actual systemd/cgroup cleanup and provider/native model acceptance remain unperformed in this worker scope.
- Same-user guardrails are not an OS sandbox or actual supplier spending meter. Existing company/provider caps must remain independently enforced.
- If an outer adapter disconnects while its admitted systemd service remains alive, that single attempt can continue until its fixed runtime deadline. Systemd retains the occupied slot; no replay is allowed. Immediate outer-process-death parity with Windows Job Objects is not claimed.
- New tasks return strict final JSON attestations; operator-written canonical receipts retain provenance. Do not pretend a denied `.claude` Write succeeded.

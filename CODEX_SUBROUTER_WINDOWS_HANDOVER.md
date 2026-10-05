# Codex / Subrouter Windows handover

Snapshot: 5 October 2026. Continue [GEN-31](https://linear.app/genxintel/issue/GEN-31/verify-subrouter-powered-codex-desktop-and-manual-subscription).

Goal: use Subrouter credit for local Codex work when the ChatGPT allowance is exhausted. Switching is manual; no automatic allowance detection or fallback has been implemented.

## Verified on the Mac

- Active user config selects provider `subrouter`, model `gpt-6-astra`, reasoning effort `low`, base URL `https://subrouter.ai/v1`, and `wire_api = "responses"`.
- Authentication uses a local command-backed helper. No credential was placed in TOML; the ChatGPT `auth.json` was not modified.
- Responses streaming completed; a synthetic function-call/result round trip passed.
- The actual bundled Codex CLI executed a shell command to read a test file, exited `0`, and returned the expected result. Its command-backed authentication test with strict config validation also passed, without a timeout.
- Bundled CLI version was `0.160.0`; the isolated test profile was `subrouter-test.config.toml` beside the user config.
- Desktop configuration was saved with a private rollback copy. **The desktop app was not restarted, and an actual GUI task using Subrouter remains unverified.** These CLI results do not establish GUI, voice, cloud-task, or plugin compatibility.

The Mac's private checkpoint records are `~/.subrouter/codex-test-checkpoint.json` and `~/.subrouter/codex-desktop-connection.json`. Keep these and local credential files private. This guide is safe to transfer; it contains no keys.

## Prepare Windows

1. Install or open the Windows Codex client, record its version, and inspect existing user settings without printing credentials. Back up its local config before editing.
2. Obtain a credential through fresh secure Subrouter sign-in/device authorization, or transfer an existing scoped key privately through a trusted secret store. Confirm available Subrouter balance. Sign in to ChatGPT normally if needed; do not migrate authentication by copying the Mac's `auth.json`.
3. Choose one authentication method: securely deliver `SUBROUTER_API_KEY` to the Codex process, or install and verify a Windows-compatible credential helper. Use its real local executable path and documented output contract; do not configure both methods. [Authentication fields](https://learn.chatgpt.com/docs/config-file/config-reference). A terminal-only variable may be absent from an app launched by the desktop, and Codex does not install a helper for you. [Official gateway setup](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway).

For the native Windows app, user settings belong in `%USERPROFILE%\.codex\config.toml`. WSL uses its own Linux config unless `CODEX_HOME` overrides it. Merge settings without duplicate keys or tables, then restart the app. [Official Windows gateway configuration](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway#configure-the-windows-app).

## Portable provider settings

This example uses the environment method. It contains the variable name, never its value:

```toml
model = "gpt-6-astra"
model_reasoning_effort = "low"
model_provider = "subrouter"
web_search = "disabled"

[model_providers.subrouter]
name = "Subrouter GPT-6 Astra"
base_url = "https://subrouter.ai/v1"
wire_api = "responses"
env_key = "SUBROUTER_API_KEY"
```

If using a verified Windows helper instead, remove `env_key` and use its `[model_providers.subrouter.auth]` settings; do not combine command authentication with `requires_openai_auth`. [Authentication fields](https://learn.chatgpt.com/docs/config-file/config-reference). Keep scalar settings before the first table. Use Windows paths; single-quoted TOML strings preserve backslashes. [Gateway configuration](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway).

Keep `gpt-6-astra` and `low` for the first verification; `low` is a supported reasoning effort. [GPT-6 Astra reference](https://developers.openai.com/api/docs/models/gpt-6-astra).

For an isolated CLI test, place these settings in `%USERPROFILE%\.codex\subrouter-test.config.toml` and select `--profile subrouter-test`. Version `0.160.0` uses separate profile files; since `0.134.0`, legacy `[profiles.name]` tables and a top-level `profile` selector are unsupported. Check the installed Windows version and `codex exec --help` before running. Provider settings belong in user config, not a repository's `.codex/config.toml`. [Profiles and config layers](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles).

```powershell
codex --version
codex exec --help
codex exec --profile subrouter-test --ephemeral --strict-config --sandbox read-only --ask-for-approval never "Reply with exactly: gateway-ok"
```

This last command spends Subrouter credit. Use a temporary test directory for the subsequent shell/file test.

## Finish verification and switching

1. Verify active provider/model in CLI `/status`, and confirm the corresponding request in Subrouter's redacted request or usage records. Model self-identification is not route evidence.
2. Verify streaming reaches completion, a real shell/file tool result returns to the model, and a follow-up turn succeeds. Check tool-call/result identifiers and any continuation transport actually used. [Gateway compatibility requirements](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).
3. Merge the working provider settings into the Windows app's user config, fully quit and reopen the app, and run a **new GUI task** that reads a harmless local test file. Confirm that request in Subrouter. Test individual plugins separately; gateway authentication does not connect their accounts. [Connection verification](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway#verify-the-connection).
4. Record Windows/client versions, sanitized config fields, exact test results, and unresolved features in GEN-31. Mark desktop verification complete only after the GUI test passes.

When the ChatGPT allowance is exhausted, manually activate the verified Subrouter settings and restart. To return to subscription-backed work, restore the pre-Subrouter **Windows** config backup and restart; ensure the expected ChatGPT account/provider is selected. The CLI profile can stay available for explicit use. Switching to Subrouter does not replenish the ChatGPT allowance.

Do not copy the entire Mac config, `auth.json`, private credentials, or helper output into GitHub, Linear, this guide, or chat. Transfer only this guide and the necessary source project; configure Windows paths, authentication, plugins, and MCP servers locally.

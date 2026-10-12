# Prepaid USD smart routing

Customers retain API WILD keys and their existing prepaid USD wallet. Supplier credentials stay server-side. The router uses the existing account/key caps, conservative credit reservation, retail settlement, native supplier reconciliation and duplicate-safe request flow.

When `APIWILD_SMART_ROUTER_ENABLED=true`, clients may send `model: "apiwild/auto"` to the existing `POST https://apiwild.com/v1/chat/completions` endpoint. The first stable policy, `usd-v1`, resolves ordinary text to `gemini-3.1-flash-lite` and requests containing function definitions or function-call history to `MiniMax-M2.7-highspeed`. An explicit real model ID continues to select that model.

```json
{
  "model": "apiwild/auto",
  "messages": [{"role": "user", "content": "Reply with the single word OK."}],
  "max_tokens": 128,
  "stream": false
}
```

Use a customer Bearer key, JSON content and a unique `Idempotency-Key`. The answer reports the actual selected model; charges use that model's published API WILD retail token prices. The alias is a policy, not an additional supplier model, and is not inserted into the accepted-model catalogue. Read `smartRouting` in `/api/gateway/config` for activation and current availability of both destinations.

The normalized selected model plus the alias/policy identity and delivery options are included in the immutable gateway fingerprint. Different request content or switching between the alias and an explicit model under an existing ID conflicts. Successful replay does not dispatch or charge again; uncertain work stays held without automatic redispatch. The private routing envelope is checked and stripped before the supplier request, which receives only the approved real model.

These destinations are fixed for this alias across restarts and releases. Do not remap it or add availability-based alternatives: a future configurable/quality policy requires a distinct alias or a separately reviewed durable routing decision ledger. An unavailable destination is rejected instead of being silently sent elsewhere. This policy does not claim a latency SLA, quality classification, broad provider arbitrage or native streaming.

The switch is disabled unless explicitly configured. Activating the switch changes no supplier key, native quota, tariff, customer balance or existing per-key access. Native playground modes continue to require explicit real models.

Verification: seven synthetic tests exercise the actual HTTP/assembly/RPC/dispatch path, USD quota rejection before supply, successful replay, changed-body conflict, buffered SSE, tool selection, held supplier failure without fallback, disabled/unavailable routes and envelope validation. These tests make no external provider call. The separately approved public customer test already verified the two underlying routes for text/SSE/function data and cost USD 0.000175 across exactly three new requests. It did not send a new public paid request through the alias.

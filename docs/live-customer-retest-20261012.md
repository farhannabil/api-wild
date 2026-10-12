# Live customer retest — 12 October 2026

The concurrency repair in `e12434443b824ce3e2ec655d6f260aac0d23b1c8` was tested through the public API using a genuine paid customer wallet and a temporary chat-only customer key. The key had USD 0.10 daily and total limits, and was revoked after the run. A subsequent protected read returned HTTP 401.

Each of the 19 enabled models received one non-streaming request: “Reply with the single word OK.”, with `max_tokens: 128`. There were no automatic retries. Seventeen returned HTTP 200, nonempty assistant content and integer token usage. Customer settled spend was USD 0.004909. Uncertain requests retain their financial holds pending reconciliation; they no longer occupy active concurrency slots.

Successful response models (Sonnet 5.5 subsequently failed supplier-cost reconciliation): MiniMax-M2.7-highspeed; claude-fable-5; claude-fable-5-1; claude-haiku-4-5; claude-haiku-4-5-20251001; claude-opus-4-6; claude-opus-4-7; claude-opus-4-8; claude-opus-5; claude-opus-5-5; claude-sonnet-4-6; claude-sonnet-5; claude-sonnet-5-5; gemini-3.1-flash-lite; gemini-3.1-pro-preview; grok-4.5; grok-4.7.

Quarantined routes:

- claude-sonnet-5-5: returned text but the supplier wallet charged quota 807 for reported usage of zero prompt tokens and one completion token, exceeding the approved supplier reserve. Do not admit new calls on this route.
- MiniMax-M3: supplier HTTP 503 in both the original test and the retest.
- gemini-2.5-flash-lite: supplier HTTP 200, but response rejected by the gateway's response validation. No successful customer delivery is claimed.

Remove these three models from Railway's `APIWILD_GATEWAY_ROUTES_JSON` alongside this release. Keep supplier bindings and historical prices for reconciliation. The acceptance manifest is narrowed to the 16 retained models; its original checkpoint dates, hashes, expiry and scope remain unchanged. This does not relabel historical sandbox evidence as live evidence.

This run verifies short non-streaming chat calls. It does not establish load capacity, uninterrupted future supplier availability, native audio, or complete function-calling/streaming coverage. Supplier reconciliation and the shared Stripe merchant-name issue must be reported separately.

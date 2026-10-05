import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubrouterDispatch, SUBROUTER_CHAT_ENDPOINT } from '../runtime/subrouter-dispatch.mjs';
const TOKEN = 'sk-syntheticOnlyNotARealCredential001';
const BUDGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const route = () => ({ providerBudgetId: BUDGET, model: 'fixture-alias', upstreamModel: 'fixture-upstream', rateVersion: 'fixture-v1', apiKey: TOKEN, capability: 'chat', maxOutputTokens: 64, maxInputChars: 100 });
const record = () => ({ provider_budget_id: BUDGET, model: 'fixture-alias', rate_version: 'fixture-v1', capability: 'chat', state: 'executing' });
const payload = () => ({ body: { model: 'fixture-alias', messages: [{ role: 'user', content: 'Synthetic fixture' }], max_tokens: 32 }, format: 'openai' });
const result = () => ({ id: 'fixture-receipt', model: 'fixture-upstream', usage: { prompt_tokens: 8, completion_tokens: 4 }, choices: [{ message: { role: 'assistant', content: 'Fixture answer' } }] });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(handler = () => response(result())) {
  const calls = []; const dispatch = createSubrouterDispatch({ routes: [route()], fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init); } });
  return { calls, dispatch, run: patch => dispatch({ record: record(), payload: payload(), signal: new AbortController().signal, ...patch }) };
}
test('one fixed-host relay call with snapshot model and no settlement assertion', async () => {
  const f = fixture(); const value = await f.run(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, SUBROUTER_CHAT_ENDPOINT); assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(JSON.parse(f.calls[0].init.body).model, 'fixture-upstream'); assert.equal(value.settlementVerified, false);
  assert.equal(value.text, 'Fixture answer'); assert.ok(!JSON.stringify(value).includes(TOKEN));
});
test('unconfigured route, stale rate and nonexecuting records never dispatch', async () => {
  for (const patch of [{ model: 'other' }, { rate_version: 'old' }, { provider_budget_id: 'wrong' }, { state: 'reserved' }]) {
    const f = fixture(); await assert.rejects(f.run({ record: { ...record(), ...patch } })); assert.equal(f.calls.length, 0);
  }
});
test('strict request bounds reject unsupported tools, streaming, wrong model and token limits before dispatch', async () => {
  for (const patch of [{ tools: [] }, { stream: true }, { model: 'other' }, { max_tokens: 65 }, { max_tokens: 0 }, { messages: [{ role: 'user', content: 'a'.repeat(101) }] }, { messages: [{ role: 'tool', content: 'unsupported' }] }]) {
    const f = fixture(); const p = payload(); Object.assign(p.body, patch); await assert.rejects(f.run({ payload: p })); assert.equal(f.calls.length, 0);
  }
});
test('missing/mismatched identity, missing usage and invalid result require reconciliation with no retry', async () => {
  for (const patch of [{ model: undefined }, { model: 'other' }, { id: '' }, { usage: {} }, { usage: { prompt_tokens: 8, completion_tokens: 40 } }, { choices: [] }]) {
    const f = fixture(() => response({ ...result(), ...patch }));
    await assert.rejects(f.run(), e => e.ambiguous && e.code === 'subrouter_dispatch_requires_reconciliation'); assert.equal(f.calls.length, 1);
  }
});
test('HTTP failures and network errors do not reveal errors, keys or trigger retries', async () => {
  for (const handler of [() => new Response(TOKEN, { status: 500 }), () => { throw new Error(TOKEN); }, () => new Response('{}', { status: 302, headers: { location: 'https://example.invalid' } })]) {
    const f = fixture(handler); await assert.rejects(f.run(), e => e.ambiguous && !e.message.includes(TOKEN)); assert.equal(f.calls.length, 1);
  }
});
test('private key in input rejected before network; echoed key cannot escape response', async () => {
  const f = fixture(); const p = payload(); p.body.messages[0].content = TOKEN; await assert.rejects(f.run({ payload: p })); assert.equal(f.calls.length, 0);
  const g = fixture(() => response({ ...result(), choices: [{ message: { role: 'assistant', content: TOKEN } }] })); await assert.rejects(g.run(), e => !e.message.includes(TOKEN));
});
test('oversized response and unsupported media response are held', async () => {
  for (const handler of [() => new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } }), () => new Response('x', { headers: { 'content-type': 'text/html' } })]) {
    const f = fixture(handler); await assert.rejects(f.run(), e => e.ambiguous); assert.equal(f.calls.length, 1);
  }
});
test('route configuration is snapshotted and empty configuration remains unavailable', async () => {
  const r = route(); const calls = []; const d = createSubrouterDispatch({ routes: [r], fetchImpl: async (url, init) => { calls.push(init); return response(result()); } });
  r.apiKey = 'sk-lateMutationMustNotBeSent000001'; await d({ record: record(), payload: payload(), signal: new AbortController().signal }); assert.equal(calls[0].headers.Authorization, 'Bearer ' + TOKEN);
  const empty = createSubrouterDispatch({ routes: [], fetchImpl: () => { throw new Error('must not call'); } }); await assert.rejects(empty({ record: record(), payload: payload(), signal: new AbortController().signal }));
});

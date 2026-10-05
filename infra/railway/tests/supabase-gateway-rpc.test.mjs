import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayRpc, SUPABASE_ORIGIN, RPC_NAMES, GatewayError, cloneJsonObject, exactInteger, withDeadline } from '../runtime/supabase-gateway-rpc.mjs';

// Synthetic fixtures only. All network behavior is an injected, exact-URL stub.
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BUDGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KEY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECRET = 'sb_secret_syntheticOnlyDoNotUse000001';
const PUBLIC = 'sb_publishable_syntheticOnlyDoNotUse000001';
const AUTH = 'Bearer syntheticHeader.syntheticPayload.syntheticSignature';
const STAMP = '2026-10-03T12:00:00.000Z';
const input = (patch = {}) => ({ keyId: KEY, providerBudgetId: BUDGET, requestKey: 'synthetic_request_01', payloadHash: 'a'.repeat(64),
  capability: 'chat', model: 'fixture-model', rateVersion: 'fixture-rate', reservedUsdMicros: 100, reservedCnyMicros: 10, ...patch });
const row = (patch = {}) => ({ id: ID, user_id: 'live:supabase:' + USER, key_id: KEY, provider_budget_id: BUDGET,
  request_key: 'synthetic_request_01', payload_hash: 'a'.repeat(64), capability: 'chat', model: 'fixture-model', rate_version: 'fixture-rate',
  state: 'reserved', version: 0, reserved_usd_micros: 100, cost_usd_micros: 0, reserved_cny_micros: 10, cost_cny_micros: 0,
  observed_cny_micros: 0, pricing_bound_exceeded: false, settlement_reference: null, result_json: null, usage_json: {},
  created_at: STAMP, updated_at: STAMP, expires_at: STAMP, ...patch });
const receipt = (patch = {}) => ({ state: 'succeeded', costUsdMicros: 40, costCnyMicros: 5,
  settlementReference: 'synthetic-receipt-not-supplier-proof', result: { answer: 'fixture' }, usage: { tokens: 3 }, ...patch });
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
function fixture(options = {}) {
  const calls = [];
  const handlers = options.handlers ?? {};
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === SUPABASE_ORIGIN + '/auth/v1/user') return handlers.user?.(url, init) ?? json({ id: USER, email: 'synthetic@example.invalid', email_confirmed_at: STAMP, is_anonymous: false });
    if (url.startsWith(SUPABASE_ORIGIN + '/rest/v1/customer_profiles?')) return handlers.profile?.(url, init) ?? json([{ user_id: USER, onboarding_completed_at: STAMP }]);
    const operation = Object.keys(RPC_NAMES).find(name => url === SUPABASE_ORIGIN + '/rest/v1/rpc/' + RPC_NAMES[name]);
    assert.ok(operation, 'only fixed RPC URLs can be requested');
    if (handlers[operation]) return handlers[operation](url, init, calls.at(-1).body);
    if (operation === 'reserve') return json({ fresh: true, record: row() });
    if (operation === 'claim') return json({ claimed: true, record: row({ state: 'executing', version: 1 }) });
    if (operation === 'uncertain') return json({ replayed: false, record: row({ state: 'uncertain', version: 2 }) });
    if (operation === 'expire') return json({ cancelled: true, record: row({ state: 'cancelled', version: 1 }) });
    const p = calls.at(-1).body;
    return json({ settled: true, replayed: false, record: row({ state: p.p_state, version: 2, cost_usd_micros: p.p_cost_usd_micros,
      cost_cny_micros: p.p_cost_cny_micros, observed_cny_micros: p.p_cost_cny_micros, settlement_reference: p.p_settlement_reference,
      result_json: p.p_result, usage_json: p.p_usage }) });
  };
  const config = { supabaseOrigin: SUPABASE_ORIGIN, secretKey: SECRET, publishableKey: PUBLIC, billingMode: 'live', fetchImpl,
    rpcTimeoutMs: 100, authTimeoutMs: 100, ...options.config };
  const rpc = createGatewayRpc(config);
  return { rpc, calls, config, async owner() { return rpc.verifyOwner({ authorization: AUTH }); }, async reserved() {
    const owner = await this.owner(); return { owner, record: (await rpc.reserve(owner, input())).record };
  } };
}
const rejectsCode = async (promise, code) => assert.rejects(promise, e => e instanceof GatewayError && e.code === code && !e.stack.includes(SECRET));

test('canonical origin, explicit credentials, fixed mode and bounded configuration', () => {
  for (const origin of ['https://bheheypylmibuicqtywx.supabase.co', SUPABASE_ORIGIN + '/', SUPABASE_ORIGIN + ':443', SUPABASE_ORIGIN.replace('https://', 'http://'), 'https://user:pass@yautmilnpllojugpmfgy.supabase.co']) {
    assert.throws(() => fixture({ config: { supabaseOrigin: origin } }), /gateway_invalid_configuration/);
  }
  for (const config of [{ billingMode: 'production' }, { secretKey: PUBLIC }, { publishableKey: SECRET }, { rpcTimeoutMs: 0 }, { authTimeoutMs: 10001 }, { ownerTtlMs: 60001 }, { sql: 'select 1' }]) {
    assert.throws(() => fixture({ config }), GatewayError);
  }
});

test('verified user and RLS profile yield a credential-free immutable opaque owner', async () => {
  const f = fixture(); const owner = await f.owner();
  assert.deepEqual(owner, { project: 'apiwild', billingMode: 'live', customerId: USER });
  assert.ok(Object.isFrozen(owner)); assert.ok(!JSON.stringify(owner).includes('syntheticHeader'));
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) { assert.equal(call.init.headers.apikey, PUBLIC); assert.equal(call.init.headers.authorization, AUTH); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store'); }
  assert.equal(f.calls[1].url, SUPABASE_ORIGIN + '/rest/v1/customer_profiles?select=user_id,onboarding_completed_at&user_id=eq.' + USER);
  f.config.billingMode = 'test';
  await f.rpc.reserve(owner, input());
  assert.equal(f.calls.at(-1).body.p_owner, 'live:supabase:' + USER);
});

test('unconfirmed, anonymous, wrong expected owner and incomplete onboarding fail closed', async () => {
  for (const patch of [{ email_confirmed_at: null }, { is_anonymous: true }, { is_anonymous: undefined }, { id: OTHER }, { id: null }]) {
    const f = fixture({ handlers: { user: () => json({ id: USER, email: 'fixture@example.invalid', email_confirmed_at: STAMP, is_anonymous: false, ...patch }) } });
    await rejectsCode(f.rpc.verifyOwner({ authorization: AUTH, expectedCustomerId: USER }), 'gateway_owner_unverified');
    assert.equal(f.calls.length, 1);
  }
  for (const profiles of [[], [{ user_id: OTHER, onboarding_completed_at: STAMP }], [{ user_id: USER, onboarding_completed_at: null }], [{ user_id: USER, onboarding_completed_at: STAMP }, { user_id: USER, onboarding_completed_at: STAMP }]]) {
    const f = fixture({ handlers: { profile: () => json(profiles) } });
    await rejectsCode(f.owner(), 'gateway_onboarding_required');
  }
});

test('forged owners, other clients, API-key bearer and expired contexts never call RPC', async () => {
  const f = fixture(); const owner = await f.owner(); const second = fixture();
  assert.throws(() => f.rpc.reserve({ ...owner }, input()), /gateway_owner_unverified/);
  assert.throws(() => second.rpc.reserve(owner, input()), /gateway_owner_unverified/);
  await rejectsCode(f.rpc.verifyOwner({ authorization: 'Bearer aw_live_' + 'a'.repeat(64) }), 'gateway_invalid_input');
  assert.equal(f.calls.length, 2); assert.equal(second.calls.length, 0);
  const short = fixture({ config: { ownerTtlMs: 1 } }); const expired = await short.owner();
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.throws(() => short.rpc.reserve(expired, input()), /gateway_owner_unverified/);
  assert.equal(short.calls.length, 2);
});

test('modern secret is apikey-only; all five operation parameters remain private and fixed', async () => {
  const f = fixture(); const { owner, record } = await f.reserved();
  const executing = (await f.rpc.claim(owner, record)).record;
  const finished = await f.rpc.finish(owner, executing, receipt());
  assert.equal(finished.settled, true); assert.equal(finished.record.state, 'succeeded');
  await f.rpc.uncertain(owner, executing); await f.rpc.expire(owner, record);
  assert.deepEqual(f.calls.slice(2).map(c => c.url.split('/').at(-1)), Object.values(RPC_NAMES));
  for (const call of f.calls.slice(2)) {
    assert.equal(call.init.method, 'POST'); assert.equal(call.init.headers.apikey, SECRET); assert.equal(call.init.headers.authorization, undefined);
    assert.equal(call.init.headers['content-profile'], 'public'); assert.equal(call.body.p_owner, 'live:supabase:' + USER);
    assert.ok(!call.init.body.includes(SECRET)); assert.equal(call.init.signal.aborted, true);
  }
  assert.deepEqual(Object.keys(f.calls[3].body).sort(), ['p_expected_version', 'p_id', 'p_owner']);
  assert.ok(Object.isFrozen(finished.record.result_json));
  assert.throws(() => { finished.record.result_json.answer = 'changed'; }, TypeError);
});

test('legacy service role compatibility requires exact project and role', async () => {
  const jwt = claims => 'syntheticHeader.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.syntheticSignature';
  const secretKey = jwt({ role: 'service_role', ref: 'yautmilnpllojugpmfgy' });
  const f = fixture({ config: { secretKey, publishableKey: jwt({ role: 'anon', ref: 'yautmilnpllojugpmfgy' }) } });
  await f.rpc.reserve(await f.owner(), input());
  assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer ' + secretKey);
  for (const claims of [{ role: 'anon', ref: 'yautmilnpllojugpmfgy' }, { role: 'service_role', ref: 'bheheypylmibuicqtywx' }]) assert.throws(() => fixture({ config: { secretKey: jwt(claims) } }), /gateway_invalid_configuration/);
});

test('raw money and ownership/configuration fields are validated before RPC', async () => {
  const f = fixture(); const owner = await f.owner();
  for (const patch of [{ reservedUsdMicros: '1' }, { reservedUsdMicros: 0 }, { reservedUsdMicros: 1.1 }, { reservedUsdMicros: Number.MAX_SAFE_INTEGER + 1 }, { reservedUsdMicros: NaN },
    { reservedUsdMicros: 1000000000001 }, { reservedCnyMicros: 50000001 }, { reservedCnyMicros: null }, { keyId: OTHER.toUpperCase() },
    { providerBudgetId: '../table' }, { requestKey: 'short' }, { payloadHash: 'z'.repeat(64) }, { capability: 'sql' }, { customerId: OTHER }, { billingMode: 'test' }, { project: 'aaro' }]) {
    assert.throws(() => f.rpc.reserve(owner, input(patch)), GatewayError);
  }
  assert.equal(f.calls.length, 2);
  assert.throws(() => exactInteger(Number.MAX_SAFE_INTEGER + 1), GatewayError);
  assert.equal(exactInteger(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('all immutable record boundaries and numeric JSON responses are checked', async () => {
  for (const patch of [{ user_id: 'live:supabase:' + OTHER }, { user_id: 'test:supabase:' + USER }, { key_id: OTHER }, { provider_budget_id: OTHER },
    { model: 'other-model' }, { rate_version: 'other-rate' }, { capability: 'code' }, { payload_hash: 'b'.repeat(64) }, { reserved_usd_micros: 99 },
    { reserved_cny_micros: 11 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { cost_usd_micros: '0' }, { state: 'unknown' }, { extra: 'not SQL' }, { usage_json: null }]) {
    const f = fixture({ handlers: { reserve: () => json({ fresh: true, record: row(patch) }) } });
    await rejectsCode(f.rpc.reserve(await f.owner(), input()), 'gateway_invalid_response');
    assert.equal(f.calls.length, 3);
  }
});

test('record handles cannot be copied or used by an unrelated verified user', async () => {
  let currentUser = USER;
  const f = fixture({ handlers: { user: () => json({ id: currentUser, email: 'fixture@example.invalid', email_confirmed_at: STAMP, is_anonymous: false }),
    profile: () => json([{ user_id: currentUser, onboarding_completed_at: STAMP }]) } }); const { owner, record } = await f.reserved();
  assert.throws(() => f.rpc.claim(owner, { ...record }), /gateway_reference_unverified/);
  assert.throws(() => fixture().rpc.claim(owner, record), /gateway_owner_unverified/);
  currentUser = OTHER; const unrelated = await f.owner();
  assert.throws(() => f.rpc.claim(unrelated, record), /gateway_reference_unverified/);
  assert.equal(f.calls.length, 5);
});

test('finite minimum and maximum currency values stay exact through JSON transport', async () => {
  for (const [usd, cny] of [[1, 1], [1000000000000, 50000000]]) {
    const f = fixture({ handlers: { reserve: () => json({ fresh: true, record: row({ reserved_usd_micros: usd, reserved_cny_micros: cny }) }) } });
    const result = await f.rpc.reserve(await f.owner(), input({ reservedUsdMicros: usd, reservedCnyMicros: cny }));
    assert.equal(result.record.reserved_usd_micros, usd); assert.equal(result.record.reserved_cny_micros, cny);
    assert.equal(f.calls.at(-1).body.p_reserved_usd_micros, usd); assert.equal(f.calls.at(-1).body.p_reserved_cny_micros, cny);
  }
});

test('dispatch authority admission is nonspending, finite and never extends the owner context', async () => {
  const f = fixture(); const owner = await f.owner();
  f.rpc.assertDispatchWindow(owner, 30000);
  assert.throws(() => f.rpc.assertDispatchWindow({ ...owner }, 30000), /gateway_owner_unverified/);
  for (const window of [0, 1.5, '30000', 40001, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.rpc.assertDispatchWindow(owner, window), GatewayError);
  const short = fixture({ config: { ownerTtlMs: 500 } }); const shortOwner = await short.owner();
  assert.throws(() => short.rpc.assertDispatchWindow(shortOwner, 100), /gateway_authority_window_insufficient/);
  assert.equal(f.calls.length, 2); assert.equal(short.calls.length, 2);
});

test('uncertain and expire enforce transition versions; unchanged false/replayed flags are safe', async () => {
  for (const operation of ['uncertain', 'expire']) {
    const handlers = { [operation]: () => json(operation === 'uncertain' ? { replayed: false, record: row({ state: 'uncertain', version: 9 }) }
      : { cancelled: true, record: row({ state: 'cancelled', version: 9 }) }) };
    const f = fixture({ handlers }); const r = await f.reserved(); const prior = operation === 'uncertain' ? (await f.rpc.claim(r.owner, r.record)).record : r.record;
    await rejectsCode(f.rpc[operation](r.owner, prior), 'gateway_invalid_response');
  }
  const f = fixture({ handlers: { expire: () => json({ cancelled: false, record: row() }), uncertain: () => json({ replayed: true, record: row({ state: 'uncertain', version: 2 }) }) } });
  const r = await f.reserved(); assert.equal((await f.rpc.expire(r.owner, r.record)).cancelled, false);
  const c = await f.rpc.claim(r.owner, r.record); assert.equal((await f.rpc.uncertain(r.owner, c.record)).replayed, true);
});

test('claim false is preserved; impossible transition/CAS responses are rejected', async () => {
  const f = fixture({ handlers: { claim: () => json({ claimed: false, record: row({ state: 'uncertain', version: 2 }) }) } });
  const { owner, record } = await f.reserved(); assert.equal((await f.rpc.claim(owner, record)).claimed, false);
  for (const patch of [{ state: 'succeeded', version: 1 }, { state: 'executing', version: 0 }, { state: 'executing', version: 2 }, { id: OTHER }]) {
    const g = fixture({ handlers: { claim: () => json({ claimed: true, record: row(patch) }) } }); const r = await g.reserved();
    await rejectsCode(g.rpc.claim(r.owner, r.record), 'gateway_invalid_response');
  }
});

test('finish forwards actual over-bound CNY rather than clamping it or releasing a quote', async () => {
  const f = fixture({ handlers: { finish: (url, init, p) => json({ settled: false, code: 'gateway_settlement_exceeds_reservation', record: row({
    state: 'uncertain', version: 2, observed_cny_micros: p.p_cost_cny_micros, pricing_bound_exceeded: true, settlement_reference: p.p_settlement_reference }) }) } });
  const { owner, record } = await f.reserved(); const executing = (await f.rpc.claim(owner, record)).record;
  const result = await f.rpc.finish(owner, executing, receipt({ costCnyMicros: 30 }));
  assert.equal(f.calls.at(-1).body.p_cost_cny_micros, 30); assert.equal(result.settled, false);
  assert.equal(result.record.cost_cny_micros, 0); assert.equal(result.record.observed_cny_micros, 30); assert.equal(result.record.pricing_bound_exceeded, true);
});

test('finish checks exact monetary/result receipt; failed outcome cannot charge the customer', async () => {
  for (const patch of [{ cost_usd_micros: 41 }, { cost_cny_micros: 6, observed_cny_micros: 6 }, { result_json: { answer: 'wrong' } },
    { usage_json: { tokens: 4 } }, { settlement_reference: 'other' }, { version: 4 }, { pricing_bound_exceeded: true }]) {
    const f = fixture({ handlers: { finish: () => json({ settled: true, replayed: false, record: row({ state: 'succeeded', version: 2, cost_usd_micros: 40,
      cost_cny_micros: 5, observed_cny_micros: 5, settlement_reference: receipt().settlementReference, result_json: { answer: 'fixture' }, usage_json: { tokens: 3 }, ...patch }) }) } });
    const r = await f.reserved(); const c = await f.rpc.claim(r.owner, r.record);
    await rejectsCode(f.rpc.finish(r.owner, c.record, receipt()), 'gateway_invalid_response');
  }
  const f = fixture(); const r = await f.reserved(); const c = await f.rpc.claim(r.owner, r.record);
  assert.throws(() => f.rpc.finish(r.owner, c.record, receipt({ state: 'failed', costUsdMicros: 1 })), /gateway_invalid_input/);
  const done = await f.rpc.finish(r.owner, c.record, receipt({ state: 'failed', costUsdMicros: 0 })); assert.equal(done.record.cost_usd_micros, 0);
});

test('deadline bounds headers and response-body stalls without depending on stub cancellation', async () => {
  const f = fixture({ config: { rpcTimeoutMs: 20 }, handlers: { reserve: () => new Promise(() => {}) } });
  const started = performance.now(); await rejectsCode(f.rpc.reserve(await f.owner(), input()), 'gateway_deadline_exceeded');
  assert.ok(performance.now() - started < 500); assert.equal(f.calls.length, 3);
  const body = fixture({ config: { rpcTimeoutMs: 20 }, handlers: { reserve: () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }) } });
  await rejectsCode(body.rpc.reserve(await body.owner(), input()), 'gateway_deadline_exceeded'); assert.equal(body.calls.length, 3);
  const auth = fixture({ config: { authTimeoutMs: 20 }, handlers: { user: () => new Promise(() => {}) } });
  await rejectsCode(auth.owner(), 'gateway_deadline_exceeded'); assert.equal(auth.calls.length, 1);
  let invocations = 0; await rejectsCode(withDeadline(() => { invocations++; return new Promise(() => {}); }, 5), 'gateway_deadline_exceeded'); assert.equal(invocations, 1);
});

test('oversized, malformed, redirected and wrong-route responses are redacted, never retried', async () => {
  const responses = [
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1200001' } }),
    () => new Response('x'.repeat(1200001), { headers: { 'content-type': 'application/json' } }),
    () => new Response('not JSON ' + SECRET, { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html>' + SECRET + '</html>', { headers: { 'content-type': 'text/html' } }),
    () => json({ arbitrary: 'SQL ' + SECRET }),
    () => { const r = json({}); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    () => { const r = json({}); Object.defineProperty(r, 'url', { value: 'https://example.invalid/table' }); return r; },
    () => json({ message: SECRET, sql: 'private-table' }, { status: 500 }),
  ];
  for (const response of responses) {
    const f = fixture({ handlers: { reserve: response } }); const owner = await f.owner();
    await assert.rejects(f.rpc.reserve(owner, input()), e => e instanceof GatewayError && e.ambiguous === true && !String(e).includes(SECRET) && !e.stack.includes('private-table'));
    assert.equal(f.calls.length, 3);
  }
});

test('auth HTTP errors distinguish invalid credentials from upstream unavailability', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({ handlers: { user: () => json({ message: SECRET }, { status }) } });
    await rejectsCode(f.owner(), [401, 403].includes(status) ? 'gateway_owner_unverified' : 'gateway_rpc_unavailable');
    assert.equal(f.calls.length, 1);
  }
});

test('credential echoes are rejected before persistence/returned record and never appear in errors', async () => {
  const f = fixture(); const owner = await f.owner();
  assert.throws(() => f.rpc.reserve(owner, input({ model: SECRET })), e => e instanceof GatewayError && !String(e).includes(SECRET)); assert.equal(f.calls.length, 2);
  for (const secret of [SECRET, ('sk' + '_live_' + 'syntheticOnlyNotARealKey'), 'aw_live_' + 'a'.repeat(64), AUTH.slice(7)]) {
    const g = fixture({ handlers: { user: () => json({ id: USER, email: 'fixture@example.invalid', email_confirmed_at: STAMP, is_anonymous: false, unexpected: secret }) } });
    await assert.rejects(g.owner(), e => e instanceof GatewayError && !String(e).includes(secret));
  }
  const g = fixture({ handlers: { reserve: () => json({ fresh: false, record: row({ state: 'succeeded', version: 2, result_json: { secret: SECRET }, settlement_reference: 'fixture' }) }) } });
  await assert.rejects(g.rpc.reserve(await g.owner(), input()), e => e instanceof GatewayError && !String(e).includes(SECRET));
});

test('inert JSON DTO snapshot rejects accessors, cycles, sparse arrays and oversized input before serialization', () => {
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { throw new Error('must never execute'); } });
  const cyclic = {}; cyclic.self = cyclic;
  const extraArray = [1]; extraArray.command = 'ignored';
  const symbolic = { [Symbol('secret')]: 'ignored' };
  for (const value of [getter, cyclic, { values: new Array(1000000000) }, { values: [1, , 3] }, { values: extraArray }, symbolic, { value: Infinity }, { toJSON() { throw new Error('must never execute'); } }]) assert.throws(() => cloneJsonObject(value), GatewayError);
  assert.throws(() => cloneJsonObject({ value: 'x'.repeat(65537) }, 65536), /gateway_payload_too_large/);
  const raw = { nested: [{ text: 'before' }] }; const copy = cloneJsonObject(raw); raw.nested[0].text = 'after'; assert.equal(copy.nested[0].text, 'before');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createOwnedGatewayFromEnv} from '../runtime/owned-gateway-assembly.mjs';
import {conversion} from './supplier-receipt-fixture.mjs';

// All remote transports are replaced; only the local HTTP adapter is exercised.
const catalog = JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json', import.meta.url), 'utf8'));
const customer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const budget = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const keyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const model = 'MiniMax-M2.7-highspeed';
const modes = ['chat', 'code', 'research'];
const routes = modes.map(capability => ({providerBudgetId: budget, model, upstreamModel: model, capability,
  maxOutputTokens: 32, maxInputTokens: 1000, maxInputChars: 1000,
  supplierReserveCnyMicros: 100000, supplierSlug: 'leapnode'}));
const env = {APIWILD_OWNED_GATEWAY_ENABLED: 'true', APIWILD_INFERENCE_ENABLED: 'true',
  SUPABASE_SECRET_KEY: 'sb_secret_syntheticFixtureOnly000000',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_syntheticFixtureOnly000000',
  APIWILD_BILLING_MODE: 'test', SUBROUTER_API_KEY: 'sk-syntheticFixtureOnly000000',
  APIWILD_RETAIL_RATE_VERSION: 'fixture-v1', APIWILD_SUPPLIER_CONVERSION_JSON: JSON.stringify(conversion),
  APIWILD_GATEWAY_ROUTES_JSON: JSON.stringify(routes)};

async function fixture({scopes = modes, deniedWorkspaceMode} = {}) {
  const records = new Map(), reservations = [], finishes = [], upstream = [], authentications = [], calls = [];
  const stamp = new Date().toISOString();
  const port = createOwnedGatewayFromEnv({env, catalog, fetchImpl: async (url, init) => {
    calls.push(url);
    if (url.endsWith('/auth/v1/user')) return Response.json({id: customer, email: 'fixture@example.test', email_confirmed_at: stamp, is_anonymous: false});
    if (url.endsWith('account_initialize')) return Response.json({initialized: true, customer_id: customer, billing_mode: 'test'});
    if (url === 'https://subrouter.ai/api/status') return Response.json({success: true, data: {
      quota_per_unit: 500000, quota_display_type: 'CNY', display_in_currency: true, price: 6.8, usd_exchange_rate: 6.8}});
    if (url === 'https://subrouter.ai/v1/chat/completions') {
      const body = JSON.parse(init.body); upstream.push(body);
      return Response.json({id: 'synthetic-completion', model, usage: {prompt_tokens: 15, completion_tokens: 1},
        choices: [{index: 0, message: {role: 'assistant', content: 'Synthetic text result'}, finish_reason: 'stop'}]},
      {headers: {'x-request-id': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}});
    }
    assert.ok(url.startsWith('https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/'), 'unexpected transport');
    const p = JSON.parse(init.body);
    if (url.endsWith('apiwild_gateway_key_authenticate')) {
      authentications.push(p);
      return Response.json({id: keyId, customer_id: customer, billing_mode: 'test', scopes,
        daily_limit_usd_micros: 1000000, total_limit_usd_micros: 10000000, expires_at: null, revoked_at: null});
    }
    if (url.endsWith('apiwild_gateway_reserve')) {
      reservations.push(p);
      // A database workspace denial must stop before claim or supplier spend.
      if (p.p_capability === deniedWorkspaceMode) return Response.json({message: 'workspace_capability_denied'}, {status: 403});
      if (records.has(p.p_request_key)) return Response.json({fresh: false, record: records.get(p.p_request_key)});
      const record = {id: 'cccccccc-cccc-4ccc-8ccc-' + String(records.size + 1).padStart(12, '0'),
        user_id: p.p_owner, key_id: p.p_key_id, provider_budget_id: p.p_provider_budget_id,
        request_key: p.p_request_key, payload_hash: p.p_payload_hash, capability: p.p_capability,
        model: p.p_model, rate_version: p.p_rate_version, state: 'reserved', version: 0,
        reserved_usd_micros: p.p_reserved_usd_micros, reserved_cny_micros: p.p_reserved_cny_micros,
        cost_usd_micros: 0, cost_cny_micros: 0, observed_cny_micros: 0, pricing_bound_exceeded: false,
        settlement_reference: null, result_json: null, usage_json: {}, created_at: stamp, updated_at: stamp,
        expires_at: new Date(Date.now() + 3600000).toISOString()};
      records.set(p.p_request_key, record); return Response.json({fresh: true, record});
    }
    const record = [...records.values()].find(row => row.id === p.p_id);
    if (url.endsWith('apiwild_gateway_claim')) {
      assert.ok(record); Object.assign(record, {state: 'executing', version: 1});
      return Response.json({claimed: true, record});
    }
    if (url.endsWith('apiwild_gateway_finish_retail')) {
      assert.ok(record); finishes.push(p); Object.assign(record, {state: p.p_state, version: 2,
        cost_usd_micros: p.p_cost_usd_micros, cost_cny_micros: p.p_cost_cny_micros,
        observed_cny_micros: p.p_cost_cny_micros, settlement_reference: p.p_settlement_reference,
        result_json: p.p_result, usage_json: p.p_usage});
      return Response.json({settled: true, replayed: false, record});
    }
    throw Error('Unexpected fixture RPC: ' + url);
  }});
  const server = createServer((req, res) => port.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {reservations, finishes, upstream, authentications, calls,
    close: () => new Promise(resolve => server.close(resolve)),
    send: (mode, {key = false, body: extra = {}, requestKey = 'fixture-textmode-' + mode + '-0001'} = {}) => new Promise((resolve, reject) => {
      const body = JSON.stringify({mode, model, messages: [{role: 'user', content: 'Synthetic prompt'}], max_tokens: 32, stream: false, ...extra});
      const req = request({host: '127.0.0.1', port: server.address().port, path: '/api/gateway', method: 'POST',
        headers: {host: 'apiwild.com', origin: 'https://apiwild.com', authorization: key
          ? 'Bearer aw_test_' + 'a'.repeat(64) : 'Bearer fixture.session.signature',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'idempotency-key': requestKey}}, res => {
        let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => resolve({status: res.statusCode, raw, body: JSON.parse(raw)}));
      }); req.on('error', reject); req.end(body);
    })};
}

test('owned assembly serves Chat, Code and Research text with one unchanged supplier budget and tariff', async () => {
  const f = await fixture(); try {
    for (const mode of modes) {
      const response = await f.send(mode);
      assert.equal(response.status, 200); assert.equal(response.body.result.text, 'Synthetic text result');
      const reserved = f.reservations.at(-1);
      assert.equal(reserved.p_capability, mode); assert.equal(reserved.p_provider_budget_id, budget);
      assert.equal(reserved.p_owner, 'test:supabase:' + customer); assert.equal(reserved.p_key_id, null);
      assert.equal(reserved.p_rate_version, 'fixture-v1'); assert.equal(reserved.p_model, model);
      assert.equal(reserved.p_reserved_cny_micros, 100000);
      assert.equal(f.upstream.at(-1).stream, false); assert.equal(f.upstream.at(-1).model, model);
      assert.equal(f.upstream.at(-1).max_tokens, 32); assert.equal(f.upstream.at(-1).tools, undefined);
      assert.equal(f.upstream.at(-1).mode, undefined);
    }
    assert.equal(f.upstream.length, 3); assert.equal(f.finishes.length, 3);
    assert.equal(new Set(f.reservations.map(row => row.p_reserved_usd_micros)).size, 1);
    assert.equal(new Set(f.finishes.map(row => row.p_cost_usd_micros)).size, 1);
    assert.ok(f.finishes.every(row => row.p_cost_cny_micros === 0 && row.p_usage.supplierReconciliationPending));
  } finally {await f.close();}
});

test('each native text mode authenticates the matching customer-key scope and retains its key', async () => {
  for (const mode of modes) {
    const f = await fixture({scopes: [mode]}); try {
      assert.equal((await f.send(mode, {key: true})).status, 200);
      assert.equal(f.authentications[0].p_capability, mode); assert.equal(f.authentications[0].p_mode, 'test');
      assert.equal(f.reservations[0].p_key_id, keyId); assert.equal(f.reservations[0].p_provider_budget_id, budget);
      assert.equal(f.upstream.length, 1);
    } finally {await f.close();}
  }
});

test('a Chat-only key cannot spend on Code or Research, even if key RPC returns a row', async () => {
  const f = await fixture({scopes: ['chat']}); try {
    for (const mode of ['code', 'research']) assert.equal((await f.send(mode, {key: true})).status, 403);
    assert.deepEqual(f.authentications.map(row => row.p_capability), ['code', 'research']);
    assert.equal(f.reservations.length, 0); assert.equal(f.upstream.length, 0); assert.equal(f.finishes.length, 0);
  } finally {await f.close();}
});

test('database workspace denial is preserved before claim, charge or supplier dispatch', async () => {
  const f = await fixture({deniedWorkspaceMode: 'research'}); try {
    assert.ok((await f.send('research')).status >= 400);
    assert.equal(f.reservations[0].p_capability, 'research'); assert.equal(f.reservations[0].p_provider_budget_id, budget);
    assert.equal(f.upstream.length, 0); assert.equal(f.finishes.length, 0);
    assert.ok(f.calls.every(url => !url.endsWith('apiwild_gateway_claim')));
  } finally {await f.close();}
});

test('unknown mode, unconfigured model, oversized output and caller budget/tool overrides cannot spend', async () => {
  const f = await fixture(); try {
    const inputs = [['voice', {}], ['unknown', {}], ['code', {model: 'unconfigured-model'}],
      ['research', {max_tokens: 33}], ['code', {providerBudgetId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'}],
      ['research', {tools: [{type: 'function', function: {name: 'search'}}]}]];
    for (const [mode, body] of inputs) assert.ok((await f.send(mode, {body})).status >= 400);
    assert.equal(f.reservations.length, 0); assert.equal(f.upstream.length, 0); assert.equal(f.finishes.length, 0);
  } finally {await f.close();}
});

test('replaying a completed Code request never dispatches or charges again', async () => {
  const f = await fixture(); try {
    const first = await f.send('code'), replay = await f.send('code');
    assert.equal(first.status, 200); assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.result, first.body.result);
    assert.equal(f.upstream.length, 1); assert.equal(f.finishes.length, 1);
  } finally {await f.close();}
});

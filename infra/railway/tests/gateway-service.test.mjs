import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createGatewayRpc, SUPABASE_ORIGIN, RPC_NAMES, GatewayError } from '../runtime/supabase-gateway-rpc.mjs';
import { createGatewayService } from '../runtime/gateway-service.mjs';

// Real transport/orchestrator exercised against in-memory, synthetic HTTP fixtures.
// These receipts are fixture labels, never acceptance of a real supplier debit.
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BUDGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KEY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECRET = 'sb_secret_syntheticOnlyDoNotUse000001';
const PUBLIC = 'sb_publishable_syntheticOnlyDoNotUse000001';
const AUTH = 'Bearer syntheticHeader.syntheticPayload.syntheticSignature';
const STAMP = '2026-10-03T12:00:00.000Z';
const reservation = () => ({ keyId: KEY, providerBudgetId: BUDGET, requestKey: 'synthetic_request_01', payloadHash: 'a'.repeat(64),
  capability: 'chat', model: 'fixture-model', rateVersion: 'fixture-rate', reservedUsdMicros: 100, reservedCnyMicros: 10 });
const payload = () => ({ body: { messages: [{ role: 'user', content: 'synthetic test only' }] }, format: 'native' });
const receipt = (patch = {}) => ({ state: 'succeeded', costUsdMicros: 40, costCnyMicros: 5,
  settlementReference: 'synthetic-receipt-not-supplier-proof', result: { answer: 'fixture' }, usage: { tokens: 3 }, ...patch });
const row = (patch = {}) => ({ id: ID, user_id: 'live:supabase:' + USER, key_id: KEY, provider_budget_id: BUDGET,
  request_key: 'synthetic_request_01', payload_hash: 'a'.repeat(64), capability: 'chat', model: 'fixture-model', rate_version: 'fixture-rate',
  state: 'reserved', version: 0, reserved_usd_micros: 100, cost_usd_micros: 0, reserved_cny_micros: 10, cost_cny_micros: 0,
  observed_cny_micros: 0, pricing_bound_exceeded: false, settlement_reference: null, result_json: null, usage_json: {},
  created_at: STAMP, updated_at: STAMP, expires_at: STAMP, ...patch });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  const calls = []; const events = []; const handles = options.handlers ?? {}; let current = row(options.row);
  const fetchImpl = async (url, init) => {
    if (url === SUPABASE_ORIGIN + '/auth/v1/user') return json({ id: USER, email: 'fixture@example.invalid', email_confirmed_at: STAMP, is_anonymous: false });
    if (url === SUPABASE_ORIGIN + '/rest/v1/customer_profiles?select=user_id,onboarding_completed_at&user_id=eq.' + USER) return json([{ user_id: USER, onboarding_completed_at: STAMP }]);
    const operation = Object.keys(RPC_NAMES).find(name => url === SUPABASE_ORIGIN + '/rest/v1/rpc/' + RPC_NAMES[name]);
    assert.ok(operation, 'no external fixture calls');
    const p = JSON.parse(init.body); calls.push({ operation, p, init }); events.push(operation);
    if (handles[operation]) return handles[operation]({ current, p, init, set(value) { current = value; } });
    if (operation === 'reserve') return json({ fresh: options.fresh ?? true, record: current });
    if (operation === 'claim') { current = { ...current, state: 'executing', version: current.version + 1 }; return json({ claimed: true, record: current }); }
    if (operation === 'uncertain') {
      if (current.state === 'succeeded') return new Response('synthetic ambiguous settlement', { status: 409 });
      current = { ...current, state: 'uncertain', version: current.version + 1 }; return json({ replayed: false, record: current });
    }
    if (operation === 'finish') {
      if (p.p_cost_usd_micros > current.reserved_usd_micros || p.p_cost_cny_micros > current.reserved_cny_micros) {
        current = { ...current, state: 'uncertain', version: current.version + 1, observed_cny_micros: p.p_cost_cny_micros,
          pricing_bound_exceeded: true, settlement_reference: p.p_settlement_reference };
        return json({ settled: false, code: 'gateway_settlement_exceeds_reservation', record: current });
      }
      current = { ...current, state: p.p_state, version: current.version + 1, cost_usd_micros: p.p_cost_usd_micros,
        cost_cny_micros: p.p_cost_cny_micros, observed_cny_micros: p.p_cost_cny_micros, settlement_reference: p.p_settlement_reference,
        result_json: p.p_result, usage_json: p.p_usage };
      return json({ settled: true, replayed: false, record: current });
    }
    throw new Error('unexpected fixture operation');
  };
  const rpc = createGatewayRpc({ supabaseOrigin: SUPABASE_ORIGIN, secretKey: SECRET, publishableKey: PUBLIC, billingMode: 'live',
    fetchImpl, rpcTimeoutMs: options.rpcTimeoutMs ?? 100, authTimeoutMs: 100 });
  let dispatchCount = 0; let verificationCount = 0;
  const dispatch = async value => { dispatchCount++; events.push('dispatch'); return options.dispatch ? options.dispatch(value) : { providerId: 'synthetic-provider-result', usage: { tokens: 3 } }; };
  const verifySettlement = async value => { verificationCount++; events.push('verify'); return options.verifySettlement ? options.verifySettlement(value) : receipt(); };
  const service = createGatewayService({ rpc, dispatch, verifySettlement, dispatchTimeoutMs: options.dispatchTimeoutMs ?? 100, settlementTimeoutMs: options.settlementTimeoutMs ?? 100 });
  return { rpc, service, calls, events, get current() { return current; }, get dispatchCount() { return dispatchCount; }, get verificationCount() { return verificationCount; },
    async owner() { return rpc.verifyOwner({ authorization: AUTH }); }, async run() { return service.execute(await this.owner(), reservation(), payload()); } };
}
function assertHeld(value) {
  assert.equal(value.ok, false); assert.equal(value.status, 'awaiting-reconciliation'); assert.equal(value.automaticRetry, false); assert.equal(value.needsReconciliation, true);
  assert.equal(value.result, undefined); assert.ok(!JSON.stringify(value).includes(SECRET)); assert.ok(!JSON.stringify(value).includes('fixture-answer-private'));
}

test('success is returned only after reserve, claim, one dispatch, trusted verification and exact settlement', async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(f.events, ['reserve', 'claim', 'dispatch', 'verify', 'finish']);
  assert.equal(f.dispatchCount, 1); assert.equal(f.verificationCount, 1); assert.equal(result.ok, true); assert.equal(result.replayed, false); assert.equal(result.result.answer, 'fixture');
  assert.equal(f.current.state, 'succeeded'); assert.equal(f.current.cost_cny_micros, 5);
  assert.deepEqual(Object.keys(result).sort(), ['id', 'ok', 'replayed', 'result']);
});

test('claimed:false never dispatches, verifies or settles', async () => {
  const f = fixture({ handlers: { claim: ({ current }) => json({ claimed: false, record: current }) } });
  assertHeld(await f.run()); assert.deepEqual(f.events, ['reserve', 'claim']); assert.equal(f.dispatchCount, 0); assert.equal(f.verificationCount, 0);
});

test('existing reservations, executing and uncertain work are never automatically redispatched', async () => {
  for (const state of ['reserved', 'executing', 'uncertain', 'cancelled']) {
    const f = fixture({ fresh: false, row: { state, version: state === 'reserved' ? 0 : 1 } });
    assertHeld(await f.run()); assert.deepEqual(f.events, ['reserve']); assert.equal(f.dispatchCount, 0);
  }
});

test('exact settled cache may replay; paid failure does not expose a usable result', async () => {
  const terminal = { state: 'succeeded', version: 2, cost_usd_micros: 40, cost_cny_micros: 5, observed_cny_micros: 5,
    settlement_reference: 'synthetic-cache-receipt', result_json: { answer: 'cached' }, usage_json: { tokens: 3 } };
  const f = fixture({ fresh: false, row: terminal }); const result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.replayed, true); assert.equal(result.result.answer, 'cached'); assert.equal(f.dispatchCount, 0);
  const g = fixture({ fresh: false, row: { ...terminal, state: 'failed', cost_usd_micros: 0, result_json: { error: 'fixture' } } });
  const failure = await g.run(); assert.equal(failure.ok, false); assert.equal(failure.status, 'failed'); assert.equal(failure.result, undefined); assert.equal(g.dispatchCount, 0);
});

test('missing terminal financial receipt cannot be treated as a paid cache', async () => {
  const f = fixture({ fresh: false, row: { state: 'succeeded', version: 2, result_json: { answer: 'fixture-answer-private' } } });
  assertHeld(await f.run()); assert.equal(f.dispatchCount, 0); assert.equal(f.events.length, 1);
});

test('settled:false supplier overrun remains held, records actual CNY and returns no answer', async () => {
  const f = fixture({ verifySettlement: () => receipt({ costCnyMicros: 30, result: { answer: 'fixture-answer-private' } }) });
  assertHeld(await f.run()); assert.equal(f.current.pricing_bound_exceeded, true); assert.equal(f.current.observed_cny_micros, 30);
  assert.equal(f.current.cost_usd_micros, 0); assert.equal(f.current.state, 'uncertain');
  assert.deepEqual(f.events, ['reserve', 'claim', 'dispatch', 'verify', 'finish']); assert.equal(f.dispatchCount, 1);
});

test('dispatch failure is marked uncertain once, with no fallback/replay/free answer', async () => {
  const f = fixture({ dispatch: () => { throw new Error('upstream-private ' + SECRET); } });
  assertHeld(await f.run()); assert.equal(f.current.state, 'uncertain'); assert.equal(f.dispatchCount, 1); assert.equal(f.verificationCount, 0);
  assert.deepEqual(f.events, ['reserve', 'claim', 'dispatch', 'uncertain']);
});

test('provider deadline bounds a callback ignoring cancellation, no late settlement', async () => {
  let completed = 0; let signal;
  const f = fixture({ dispatchTimeoutMs: 15, dispatch: value => { signal = value.signal; return new Promise(resolve => setTimeout(() => { completed++; resolve({ answer: 'fixture-answer-private' }); }, 50)); } });
  const start = performance.now(); assertHeld(await f.run()); assert.ok(performance.now() - start < 500); assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(completed, 1); assert.equal(f.dispatchCount, 1); assert.equal(f.verificationCount, 0); assert.deepEqual(f.events, ['reserve', 'claim', 'dispatch', 'uncertain']);
});

test('settlement verification timeout retains liability; there is no second provider attempt', async () => {
  const f = fixture({ settlementTimeoutMs: 15, verifySettlement: () => new Promise(() => {}) });
  assertHeld(await f.run()); assert.equal(f.dispatchCount, 1); assert.equal(f.verificationCount, 1); assert.equal(f.current.state, 'uncertain');
  assert.deepEqual(f.events, ['reserve', 'claim', 'dispatch', 'verify', 'uncertain']);
});

test('lost reserve or claim responses are ambiguous, never automatically retried or dispatched', async () => {
  for (const operation of ['reserve', 'claim']) {
    const f = fixture({ rpcTimeoutMs: 15, handlers: { [operation]: () => new Promise(() => {}) } });
    assertHeld(await f.run()); assert.equal(f.dispatchCount, 0); assert.equal(f.calls.filter(c => c.operation === operation).length, 1);
    assert.ok(!f.events.includes('uncertain'));
  }
});

test('lost finish response may already be committed; uncertain conflict cannot cause replay/release', async () => {
  const f = fixture({ handlers: { finish: ({ current, p, set }) => {
    set({ ...current, state: 'succeeded', version: 2, cost_usd_micros: p.p_cost_usd_micros, cost_cny_micros: p.p_cost_cny_micros,
      observed_cny_micros: p.p_cost_cny_micros, settlement_reference: p.p_settlement_reference, result_json: p.p_result, usage_json: p.p_usage });
    throw new Error('synthetic connection lost after commit ' + SECRET);
  } } });
  assertHeld(await f.run()); assert.equal(f.current.state, 'succeeded'); assert.equal(f.dispatchCount, 1);
  assert.deepEqual(f.events, ['reserve', 'claim', 'dispatch', 'verify', 'finish', 'uncertain']);
});

test('malformed or conflicting finish results never expose the provider answer', async () => {
  const f = fixture({ handlers: { finish: ({ current }) => json({ settled: true, replayed: false, record: { ...current, state: 'succeeded', version: 2,
    cost_usd_micros: 1, cost_cny_micros: 1, observed_cny_micros: 1, settlement_reference: 'wrong', result_json: { answer: 'fixture-answer-private' } } }) } });
  assertHeld(await f.run()); assert.equal(f.dispatchCount, 1); assert.equal(f.events.at(-1), 'uncertain');
});

test('invalid settlement money/shape and raw credentials fail before finish; request stays uncertain', async () => {
  for (const value of [receipt({ costUsdMicros: 1.5 }), receipt({ costCnyMicros: Number.MAX_SAFE_INTEGER + 1 }), receipt({ customerId: USER }),
    receipt({ result: { token: SECRET } }), receipt({ state: 'failed', costUsdMicros: 1 }), { verified: true, receipt: 'seller-says-so' }]) {
    const f = fixture({ verifySettlement: () => value }); assertHeld(await f.run());
    assert.equal(f.dispatchCount, 1); assert.equal(f.calls.filter(c => c.operation === 'finish').length, 0); assert.equal(f.current.state, 'uncertain');
  }
});

test('provider credential echoes, oversized/malformed results are not returned or settled', async () => {
  for (const value of [{ answer: SECRET }, { answer: 'x'.repeat(1048577) }, ['unexpected-root-array'], { answer: undefined }]) {
    const f = fixture({ dispatch: () => value }); assertHeld(await f.run());
    assert.equal(f.verificationCount, 0); assert.equal(f.calls.filter(c => c.operation === 'finish').length, 0); assert.equal(f.current.state, 'uncertain');
  }
});

test('paid provider failure settles supplier CNY but never charges or answers the customer', async () => {
  const f = fixture({ verifySettlement: () => receipt({ state: 'failed', costUsdMicros: 0, result: { error: 'fixture' } }) });
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.status, 'failed'); assert.equal(result.result, undefined);
  assert.equal(f.current.cost_usd_micros, 0); assert.equal(f.current.cost_cny_micros, 5); assert.equal(f.dispatchCount, 1);
});

test('invalid owner, customer/mode injection and oversized payload fail without dispatch', async () => {
  const f = fixture(); const owner = await f.owner();
  await assert.rejects(f.service.execute({ ...owner }, reservation(), payload()), /gateway_owner_unverified/);
  await assert.rejects(f.service.execute(owner, { ...reservation(), customerId: USER }, payload()), /gateway_invalid_input/);
  await assert.rejects(f.service.execute(owner, { ...reservation(), billingMode: 'test' }, payload()), /gateway_invalid_input/);
  await assert.rejects(f.service.execute(owner, reservation(), { value: 'x'.repeat(65537) }), /gateway_payload_too_large/);
  assert.equal(f.calls.length, 0); assert.equal(f.dispatchCount, 0);
});

test('payload is snapshotted before reservation; no getter or late mutation reaches dispatch', async () => {
  const f = fixture({ handlers: { reserve: ({ current }) => json({ fresh: true, record: current }) }, dispatch: ({ payload }) => {
    assert.equal(payload.body.messages[0].content, 'synthetic test only'); return { providerId: 'fixture' };
  } });
  const owner = await f.owner(); const raw = payload(); const pending = f.service.execute(owner, reservation(), raw); raw.body.messages[0].content = 'after';
  assert.equal((await pending).ok, true);
  const getter = {}; Object.defineProperty(getter, 'command', { enumerable: true, get() { throw new Error('must not execute'); } });
  await assert.rejects(f.service.execute(owner, reservation(), getter), GatewayError);
  assert.equal(f.dispatchCount, 1);
});

test('unknown owner/record response is held before dispatch; service requires explicit trusted ports', async () => {
  const f = fixture({ handlers: { reserve: ({ current }) => json({ fresh: true, record: { ...current, user_id: 'test:supabase:' + USER } }) } });
  assertHeld(await f.run()); assert.equal(f.dispatchCount, 0);
  assert.throws(() => createGatewayService({ rpc: f.rpc, dispatch() {} }), /gateway_service_unconfigured/);
  assert.throws(() => createGatewayService({ rpc: f.rpc, dispatch() {}, verifySettlement() {}, dispatchTimeoutMs: 30001 }), /gateway_invalid_integer/);
});

test('isolated monotonic clock: aggregate admission rejects slow/near-expired authority before provider spend', { timeout: 4500 }, async () => {
  // Only this bounded synthetic child owns the virtual clock. Test workers and
  // production configuration retain their real performance.now() unmodified.
  // No shell, file writes, environment credentials or real network are used.
  const child = `
import assert from 'node:assert/strict';
import {createGatewayRpc,SUPABASE_ORIGIN,RPC_NAMES} from ${JSON.stringify(new URL('../runtime/supabase-gateway-rpc.mjs', import.meta.url).href)};
import {createGatewayService} from ${JSON.stringify(new URL('../runtime/gateway-service.mjs', import.meta.url).href)};
let now=0; Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
const USER=${JSON.stringify(USER)}, ID=${JSON.stringify(ID)}, KEY=${JSON.stringify(KEY)}, BUDGET=${JSON.stringify(BUDGET)}, STAMP=${JSON.stringify(STAMP)};
const base=${JSON.stringify(row())}, quote=${JSON.stringify(reservation())}, result=${JSON.stringify(receipt())}, body=${JSON.stringify(payload())};
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function scenario(stages,preAdvance=0){
  let current={...base}, dispatches=0; const actions=[];
  const rpc=createGatewayRpc({supabaseOrigin:SUPABASE_ORIGIN,secretKey:${JSON.stringify(SECRET)},publishableKey:${JSON.stringify(PUBLIC)},billingMode:'live',fetchImpl:async(url,init)=>{
    if(url===SUPABASE_ORIGIN+'/auth/v1/user')return json({id:USER,email:'fixture@example.invalid',email_confirmed_at:STAMP,is_anonymous:false});
    if(url===SUPABASE_ORIGIN+'/rest/v1/customer_profiles?select=user_id,onboarding_completed_at&user_id=eq.'+USER)return json([{user_id:USER,onboarding_completed_at:STAMP}]);
    const op=Object.keys(RPC_NAMES).find(name=>url===SUPABASE_ORIGIN+'/rest/v1/rpc/'+RPC_NAMES[name]);assert.ok(op);actions.push(op);now+=stages[op]||0;
    if(op==='reserve')return json({fresh:true,record:current});
    if(op==='claim'){current={...current,state:'executing',version:1};return json({claimed:true,record:current});}
    if(op==='uncertain'){current={...current,state:'uncertain',version:2};return json({replayed:false,record:current});}
    assert.equal(op,'finish');const p=JSON.parse(init.body);current={...current,state:p.p_state,version:2,cost_usd_micros:p.p_cost_usd_micros,cost_cny_micros:p.p_cost_cny_micros,observed_cny_micros:p.p_cost_cny_micros,settlement_reference:p.p_settlement_reference,result_json:p.p_result,usage_json:p.p_usage};return json({settled:true,replayed:false,record:current});
  }});
  const owner=await rpc.verifyOwner({authorization:${JSON.stringify(AUTH)}}); now+=preAdvance;
  const service=createGatewayService({rpc,dispatch:async()=>{dispatches++;now+=stages.dispatch||0;return {synthetic:true};},verifySettlement:async()=>{now+=stages.verify||0;return result;}});
  const output=await service.execute(owner,quote,body);return {output,actions,dispatches,state:current.state};
}
const slow=await scenario({reserve:12000,claim:12000,dispatch:25000,verify:5000,finish:12000,uncertain:12000});
assert.equal(slow.dispatches,0);assert.equal(slow.state,'uncertain');assert.deepEqual(slow.actions,['reserve','claim','uncertain']);assert.equal(slow.output.automaticRetry,false);assert.equal(slow.output.result,undefined);
const near=await scenario({},59000);assert.equal(near.dispatches,0);assert.equal(near.state,'uncertain');assert.deepEqual(near.actions,['reserve','claim','uncertain']);assert.equal(near.output.status,'awaiting-reconciliation');
const fast=await scenario({});assert.equal(fast.dispatches,1);assert.equal(fast.state,'succeeded');assert.equal(fast.output.ok,true);assert.deepEqual(fast.actions,['reserve','claim','finish']);
const overrun=await scenario({dispatch:65000});assert.equal(overrun.dispatches,1);assert.equal(overrun.state,'executing');assert.equal(overrun.output.ok,false);assert.equal(overrun.output.automaticRetry,false);assert.equal(overrun.output.result,undefined);assert.deepEqual(overrun.actions,['reserve','claim']);
console.log(JSON.stringify({slow:{dispatches:slow.dispatches,state:slow.state},near:{dispatches:near.dispatches,state:near.state},fast:{dispatches:fast.dispatches,state:fast.state},overrun:{dispatches:overrun.dispatches,state:overrun.state}}));
`;
  const execution = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '--eval', child], {
    timeout: 3500, windowsHide: true, maxBuffer: 20000, env: process.platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {},
  }, (error, stdout, stderr) => resolve({ exitCode: error ? error.code : 0, signal: error?.signal ?? null, stdout, stderr })));
  assert.equal(execution.exitCode, 0); assert.equal(execution.signal, null); assert.equal(execution.stderr, '');
  assert.deepEqual(JSON.parse(execution.stdout), { slow: { dispatches: 0, state: 'uncertain' }, near: { dispatches: 0, state: 'uncertain' },
    fast: { dispatches: 1, state: 'succeeded' }, overrun: { dispatches: 1, state: 'executing' } });
});

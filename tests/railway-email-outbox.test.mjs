import test from 'node:test';
import assert from 'node:assert/strict';
import {processWelcomeOutbox, welcomeMessage} from '../infra/railway/resend-outbox.mjs';
const id = '12345678-1234-4123-8123-123456789abc';
const receipt = 'abcdef12-1234-4123-8123-123456789abc';
const job = {id, lease_id: receipt, brand_slug: 'apiwild', template: 'confirmed-welcome-v1', recipient: 'delivered@resend.dev'};
const env = {EMAIL_AUTOMATION_ENABLED: 'true', SUPABASE_URL: 'https://yautmilnpllojugpmfgy.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-server-only', RESEND_API_KEY: 'fixture-send-only'};
function harness(provider = () => Response.json({id: receipt})) {
  const calls = [];
  return {calls, fetchImpl: async (url, options) => {
    calls.push({url, ...options, body: JSON.parse(options.body)});
    if (url.endsWith('/claim_confirmed_welcome')) return Response.json([job]);
    if (url.endsWith('/finish_confirmed_welcome')) return Response.json(null);
    assert.equal(url, 'https://api.resend.com/emails'); return provider();
  }};
}
test('default disabled makes no network calls', async () => {
  assert.deepEqual(await processWelcomeOutbox({env: {}, fetchImpl: () => assert.fail('network')}), {enabled: false, claimed: 0});
});
test('wrong Supabase or missing credentials fail before network', async () => {
  for (const invalid of [{SUPABASE_URL: 'https://bheheypylmibuicqtywx.supabase.co'}, {RESEND_API_KEY: ''}, {SUPABASE_SERVICE_ROLE_KEY: ''}]) {
    await assert.rejects(processWelcomeOutbox({env: {...env, ...invalid}, fetchImpl: () => assert.fail('network')}));
  }
});
test('bounded batch rejects zero, fractional and excess limits', async () => {
  for (const limit of [0, 1.5, 6]) await assert.rejects(processWelcomeOutbox({env, limit, fetchImpl: () => assert.fail('network')}));
});
test('two brands use existing verified sender and stable canonical links', () => {
  for (const brand of ['apiwild', 'aaro']) {
    const message = welcomeMessage({...job, brand_slug: brand});
    assert.match(message.from, /<support@apiwild\.com>$/);
    assert.ok(message.text.includes(brand === 'aaro' ? 'https://aaroglobal.com' : 'https://apiwild.com'));
    assert.match(message.html, /<a href="https:\/\//);
  }
});
test('recipient injection, arbitrary template/brand and invalid identity rejected', () => {
  for (const invalid of [{recipient: 'x@y.com\r\nBcc: z@y.com'}, {recipient:'x\u0000@y.com'}, {recipient:'x\u007f@y.com'}, {brand_slug: '<img>'}, {brand_slug: '__proto__'}, {brand_slug: 'constructor'}, {template: 'invoice'}, {id: 'bad'}, {lease_id: 'bad'}]) {
    assert.throws(() => welcomeMessage({...job, ...invalid}));
  }
});
test('success uses fixed server endpoints, stable idempotency, counts and provider ID only', async () => {
  const h = harness(), result = await processWelcomeOutbox({env, ...h});
  assert.equal(result.providerAccepted, 1);
  assert.equal(h.calls[1].headers['Idempotency-Key'], `welcome-email/${id}`);
  assert.equal(h.calls[1].headers.Authorization, 'Bearer fixture-send-only');
  assert.equal(h.calls[0].headers.apikey, 'fixture-server-only');
  assert.equal(h.calls[1].headers.apikey, undefined);
  assert.ok(h.calls.every(c => c.redirect === 'error'));
  assert.equal(h.calls[2].body.p_provider_id, receipt);
  assert.equal(h.calls[2].body.p_lease_id, receipt);
  assert.ok(!JSON.stringify(result).includes(job.recipient));
});
for (const status of [400, 401, 403, 409, 422]) test(`nonretryable provider ${status} is never automatically resent`, async () => {
  const h = harness(() => new Response('', {status}));
  assert.equal((await processWelcomeOutbox({env, ...h})).failed, 1);
  assert.equal(h.calls[2].body.p_outcome, 'failed'); assert.equal(h.calls.length, 3);
});
for (const status of [429, 500, 503]) test(`provider ${status} requests database-bounded deferral, not inline retry`, async () => {
  const h = harness(() => new Response('', {status}));
  assert.equal((await processWelcomeOutbox({env, ...h})).deferred, 1);
  assert.equal(h.calls[2].body.p_outcome, 'retry'); assert.equal(h.calls.length, 3);
});
test('lost provider response leaves ambiguous for reconciliation and never retries', async () => {
  const h = harness(() => {throw new Error('fixture transport failure');});
  assert.equal((await processWelcomeOutbox({env, ...h})).ambiguous, 1);
  assert.equal(h.calls[2].body.p_outcome, 'ambiguous'); assert.equal(h.calls.length, 3);
});
test('malformed provider success cannot be called sent', async () => {
  const h = harness(() => Response.json({id: 'bad'}));
  assert.equal((await processWelcomeOutbox({env, ...h})).ambiguous, 1);
});
test('failed queue claim cannot send', async () => {
  let calls = 0;
  await assert.rejects(processWelcomeOutbox({env, fetchImpl: async () => {calls++; return new Response('', {status: 503});}}));
  assert.equal(calls, 1);
});
test('outsize or nonarray queue receipt cannot send', async () => {
  for (const data of [{}, [job, job]]) await assert.rejects(processWelcomeOutbox({env, fetchImpl: async () => Response.json(data)}));
});
test('malformed lease anywhere in a batch prevents every provider send', async () => {
  for (const invalid of [null, {...job, id: 'bad'}, {...job, lease_id: 'bad'}]) {
    let calls = 0;
    await assert.rejects(processWelcomeOutbox({env, limit: 2, fetchImpl: async url => {
      calls++;
      assert.ok(url.endsWith('/claim_confirmed_welcome'));
      return Response.json([job, invalid]);
    }}), /email_queue_receipt_invalid/);
    assert.equal(calls, 1);
  }
});
test('lost final database write after provider acceptance cannot trigger another send', async () => {
  const h = harness(), original = h.fetchImpl;
  h.fetchImpl = async (url, options) => {
    if (url.endsWith('/finish_confirmed_welcome')) throw new Error('fixture lost DB write');
    return original(url, options);
  };
  await assert.rejects(processWelcomeOutbox({env, ...h}));
  assert.equal(h.calls.filter(c => c.url === 'https://api.resend.com/emails').length,1);
  // The SQL claim remains processing; the actual Postgres suite verifies that
  // processing/ambiguous rows are never automatically claimed again.
});

for (const [label, provider] of [
 ['oversized header', () => new Response('{}', {headers:{'Content-Length':'16385'}})],
 ['oversized streamed body', () => new Response('x'.repeat(16385))],
 ['malformed UTF-8', () => new Response(new Uint8Array([0xff]))],
 ['invalid JSON', () => new Response('{')],
 ['endless empty frames', () => new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(0));}}))],
]) test(`bounded provider ${label} remains ambiguous with no inline resend`, async () => {
 const h=harness(provider); const result=await processWelcomeOutbox({env,...h});
 assert.equal(result.ambiguous,1);assert.equal(result.providerAccepted,0);
 assert.equal(h.calls[2].body.p_outcome,'ambiguous');assert.equal(h.calls.length,3);
});

test('provider transport ignoring its signal still reaches a finite ambiguous outcome',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let entered;const reached=new Promise(resolve=>entered=resolve);
 const h=harness(()=>{entered();return new Promise(()=>{});});
 const pending=processWelcomeOutbox({env,...h});await reached;t.mock.timers.tick(15000);
 const result=await pending;assert.equal(result.ambiguous,1);assert.equal(h.calls.length,3);assert.equal(h.calls[1].signal.aborted,true);
});

test('provider receipt body stall shares the transport deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let started;const reached=new Promise(resolve=>started=resolve);
 const h=harness(()=>new Response(new ReadableStream({pull(){started();return new Promise(()=>{});}})));
 const pending=processWelcomeOutbox({env,...h});await reached;await Promise.resolve();t.mock.timers.tick(15000);
 const result=await pending;assert.equal(result.ambiguous,1);assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.p_outcome,'ambiguous');
});

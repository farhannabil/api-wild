import test from 'node:test';
import assert from 'node:assert/strict';
import {claimConfirmedWelcome, finishConfirmedWelcome, WelcomeRpcError, SUPABASE_ORIGIN} from '../runtime/welcome-rpc.mjs';

const id = '12345678-1234-4123-8123-123456789abc';
const leaseId = 'abcdef12-1234-4123-8123-123456789abc';
const providerId = '98765432-1234-4123-8123-123456789abc';
const serviceRoleKey = 'fixture-service-role-key';
const validJob = {
  id,
  lease_id: leaseId,
  brand_slug: 'apiwild',
  template: 'confirmed-welcome-v1',
  recipient: 'delivered@resend.dev',
};

function mockFetch(response) {
  return async (url, options) => {
    return response;
  };
}
async function flushMicrotasks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

// claimConfirmedWelcome tests

test('claim requires service role key', async () => {
  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey: '', limit: 1, fetchImpl: () => assert.fail('should not fetch')}),
    {code: 'missing_service_role_key'}
  );
});

test('claim requires integer limit between 1 and 5', async () => {
  for (const limit of [0, 0.5, 6, 10, -1]) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit, fetchImpl: () => assert.fail('should not fetch')}),
      {code: 'invalid_limit'}
    );
  }
});

test('claim uses fixed endpoint, auth headers and POST method', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = {url, ...options};
    return Response.json([validJob]);
  };

  await claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl});

  assert.equal(captured.url, `${SUPABASE_ORIGIN}/rest/v1/rpc/claim_confirmed_welcome`);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.headers.apikey, serviceRoleKey);
  assert.equal(captured.headers.Authorization, `Bearer ${serviceRoleKey}`);
  assert.equal(captured.headers['Content-Type'], 'application/json');
  const body = JSON.parse(captured.body);
  assert.equal(body.p_limit, 1);
});

test('claim timeout bounds a transport that ignores its signal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let signal, calls = 0;
  const rejected = assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1,
    fetchImpl: async (_, options) => { calls++; signal = options.signal; return new Promise(() => {}); }}),
  {code: 'claim_timeout', ambiguous: true});
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('claim network failure marks request ambiguous', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };

  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl}),
    {code: 'claim_network_failed', ambiguous: true}
  );
});

test('claim non-ok response fails without ambiguity', async () => {
  for (const status of [400, 401, 403, 500, 503]) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(new Response('', {status}))}),
      {code: 'claim_rpc_failed', ambiguous: false}
    );
  }
});

test('claim redirect response fails', async () => {
  const fetchImpl = async (url, options) => {
    const error = new TypeError('redirect mode is set to error');
    error.cause = 'redirect';
    throw error;
  };

  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl}),
    {code: 'claim_network_failed'}
  );
});

test('claim rejects non-array response', async () => {
  for (const data of [{}, null, 'string', 42]) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json(data))}),
      {code: 'claim_response_not_array'}
    );
  }
});

test('claim rejects response exceeding requested limit', async () => {
  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([validJob, validJob]))}),
    {code: 'claim_response_too_many'}
  );
});

test('claim rejects duplicate job IDs in batch', async () => {
  const duplicate = {...validJob, lease_id: '11111111-1234-4123-8123-123456789abc'};
  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 2, fetchImpl: mockFetch(Response.json([validJob, duplicate]))}),
    {code: 'claim_duplicate_id'}
  );
});

test('claim rejects duplicate lease IDs in batch', async () => {
  const duplicate = {...validJob, id: '11111111-1234-4123-8123-123456789abc'};
  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 2, fetchImpl: mockFetch(Response.json([validJob, duplicate]))}),
    {code: 'claim_duplicate_lease_id'}
  );
});

test('claim rejects job with invalid shape', async () => {
  for (const invalid of [null, [], 'string', 42]) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([invalid]))}),
      {code: 'claim_job_invalid_shape'}
    );
  }
});

test('claim rejects job with malformed IDs', async () => {
  for (const invalid of [{...validJob, id: 'not-a-uuid'}, {...validJob, lease_id: 'bad'}, {...validJob, id: null}]) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([invalid]))}),
      {code: 'claim_job_invalid_ids'}
    );
  }
});

test('claim rejects job with wrong template', async () => {
  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([{...validJob, template: 'invoice'}]))}),
    {code: 'claim_job_invalid_template'}
  );
});

test('claim rejects job with missing or invalid brand', async () => {
  for (const invalid of [{...validJob, brand_slug: ''}, {...validJob, brand_slug: null}, {...validJob, brand_slug: 123}]) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([invalid]))}),
      {code: 'claim_job_missing_brand'}
    );
  }
});

test('claim rejects job with injection attempts in recipient', async () => {
  for (const recipient of ['test@example.com\r\nBcc: evil@example.com', 'test\u0000@example.com', 'test\u007f@example.com']) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([{...validJob, recipient}]))}),
      {code: 'claim_job_invalid_recipient'}
    );
  }
});

test('claim rejects job with malformed recipient', async () => {
  for (const recipient of ['', 'not-an-email', '@example.com', 'test@', 'test @example.com', 'x'.repeat(255) + '@example.com']) {
    await assert.rejects(
      claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([{...validJob, recipient}]))}),
      {code: 'claim_job_invalid_recipient'}
    );
  }
});

test('claim enforces the actual 32KiB streamed byte boundary', async () => {
  const json = JSON.stringify([validJob]);
  const atLimit = json + ' '.repeat(32768 - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(atLimit), 32768);
  assert.equal((await claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(new Response(atLimit))})).length, 1);
  const overLimit = atLimit + ' ';
  assert.equal(Buffer.byteLength(overLimit), 32769);
  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(new Response(overLimit))}),
    {code: 'response_too_large'}
  );
  const multibyte = JSON.stringify([{...validJob, recipient: '\u00e9'.repeat(17000) + '@resend.dev'}]);
  assert.ok(multibyte.length < 32768 && Buffer.byteLength(multibyte) > 32768);
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(new Response(multibyte))}), {code: 'response_too_large'});
});

test('claim body that hangs after headers shares the same deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('[{"id":"')); },
    cancel() { cancelled = true; },
  }));
  const rejected = assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(response)}),
    {code: 'claim_timeout', ambiguous: true});
  await flushMicrotasks();
  t.mock.timers.tick(10000);
  await rejected; assert.equal(cancelled, true);
});

test('claim malformed JSON response fails', async () => {
  const fetchImpl = async () => new Response('{invalid json', {status: 200});

  await assert.rejects(
    claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl}),
    {code: 'response_malformed'}
  );
});

test('claim successful with valid batch', async () => {
  const job2 = {...validJob, id: '22222222-1234-4123-8123-123456789abc', lease_id: '33333333-1234-4123-8123-123456789abc'};
  const jobs = await claimConfirmedWelcome({
    serviceRoleKey,
    limit: 2,
    fetchImpl: mockFetch(Response.json([validJob, job2]))
  });

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, validJob.id);
  assert.equal(jobs[1].id, job2.id);
});

// finishConfirmedWelcome tests

test('finish requires service role key', async () => {
  await assert.rejects(
    finishConfirmedWelcome({serviceRoleKey: '', id, leaseId, outcome: 'sent', providerId, fetchImpl: () => assert.fail()}),
    {code: 'missing_service_role_key'}
  );
});

test('finish validates UUID format for id and leaseId', async () => {
  await assert.rejects(
    finishConfirmedWelcome({serviceRoleKey, id: 'bad', leaseId, outcome: 'sent', providerId, fetchImpl: () => assert.fail()}),
    {code: 'invalid_uuid'}
  );
  await assert.rejects(
    finishConfirmedWelcome({serviceRoleKey, id, leaseId: 'bad', outcome: 'sent', providerId, fetchImpl: () => assert.fail()}),
    {code: 'invalid_uuid'}
  );
});

test('finish only accepts allowed outcomes', async () => {
  for (const outcome of ['success', 'pending', 'unknown', '', null]) {
    await assert.rejects(
      finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome, providerId: null, fetchImpl: () => assert.fail()}),
      {code: 'invalid_outcome'}
    );
  }
});

test('finish validates outcome/provider pairing: sent requires UUID', async () => {
  await assert.rejects(
    finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'sent', providerId: null, fetchImpl: () => assert.fail()}),
    {code: 'sent_requires_provider_id'}
  );
});

test('finish validates outcome/provider pairing: non-sent requires null', async () => {
  for (const outcome of ['retry', 'failed', 'ambiguous']) {
    await assert.rejects(
      finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome, providerId, fetchImpl: () => assert.fail()}),
      {code: 'non_sent_requires_null_provider'}
    );
  }
});

test('finish uses fixed endpoint, auth headers and POST method', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = {url, ...options};
    return new Response(null, {status: 204});
  };

  await finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'sent', providerId, fetchImpl});

  assert.equal(captured.url, `${SUPABASE_ORIGIN}/rest/v1/rpc/finish_confirmed_welcome`);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.headers.apikey, serviceRoleKey);
  assert.equal(captured.headers.Authorization, `Bearer ${serviceRoleKey}`);
  const body = JSON.parse(captured.body);
  assert.equal(body.p_id, id);
  assert.equal(body.p_lease_id, leaseId);
  assert.equal(body.p_outcome, 'sent');
  assert.equal(body.p_provider_id, providerId);
});

test('finish timeout bounds a transport that ignores its signal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let signal, calls = 0;
  const rejected = assert.rejects(finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'sent', providerId,
    fetchImpl: async (_, options) => { calls++; signal = options.signal; return new Promise(() => {}); }}),
    {code: 'finish_timeout', ambiguous: true});
  t.mock.timers.tick(10000);
  await rejected; assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('finish network failure marks request ambiguous', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };

  await assert.rejects(
    finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'failed', providerId: null, fetchImpl}),
    {code: 'finish_network_failed', ambiguous: true}
  );
});

test('finish non-ok response fails without ambiguity', async () => {
  for (const status of [400, 401, 403, 409, 500]) {
    await assert.rejects(
      finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'retry', providerId: null, fetchImpl: mockFetch(new Response('', {status}))}),
      {code: 'finish_rpc_failed', ambiguous: false}
    );
  }
});

test('finish accepts 204 no content', async () => {
  const result = await finishConfirmedWelcome({
    serviceRoleKey,
    id,
    leaseId,
    outcome: 'sent',
    providerId,
    fetchImpl: mockFetch(new Response(null, {status: 204}))
  });

  assert.equal(result, null);
});

test('finish accepts null JSON response', async () => {
  const result = await finishConfirmedWelcome({
    serviceRoleKey,
    id,
    leaseId,
    outcome: 'failed',
    providerId: null,
    fetchImpl: mockFetch(Response.json(null))
  });

  assert.equal(result, null);
});

test('finish rejects non-null JSON response', async () => {
  for (const data of [{}, [], 'string', 42, {success: true}]) {
    await assert.rejects(
      finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'ambiguous', providerId: null, fetchImpl: mockFetch(Response.json(data))}),
      {code: 'finish_unexpected_response'}
    );
  }
});

test('finish all four outcomes with correct provider pairing', async () => {
  for (const outcome of ['sent', 'retry', 'failed', 'ambiguous']) {
    const provider = outcome === 'sent' ? providerId : null;
    const result = await finishConfirmedWelcome({
      serviceRoleKey,
      id,
      leaseId,
      outcome,
      providerId: provider,
      fetchImpl: mockFetch(new Response(null, {status: 204}))
    });
    assert.equal(result, null);
  }
});

test('claim validates exactly five fields and only the two approved brands', async () => {
  for (const invalid of [{...validJob, extra: 'fixture-private'}, {...validJob, brand_slug: 'third-brand'}, {...validJob, brand_slug: '__proto__'},
    {id, lease_id: leaseId, brand_slug: 'apiwild', recipient: validJob.recipient}]) {
    await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([invalid]))}));
  }
  const [aaro] = await claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([{...validJob, brand_slug: 'aaro'}]))});
  assert.equal(aaro.brand_slug, 'aaro');
});

test('case-variant UUIDs cannot create duplicate jobs or leases', async () => {
  const otherId = '22222222-1234-4123-8123-123456789abc', otherLease = '33333333-1234-4123-8123-123456789abc';
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 2, fetchImpl: mockFetch(Response.json([
    validJob, {...validJob, id: id.toUpperCase(), lease_id: otherLease},
  ]))}), {code: 'claim_duplicate_id'});
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 2, fetchImpl: mockFetch(Response.json([
    validJob, {...validJob, id: otherId, lease_id: leaseId.toUpperCase()},
  ]))}), {code: 'claim_duplicate_lease_id'});
  const [canonical] = await claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(Response.json([
    {...validJob, id: id.toUpperCase(), lease_id: leaseId.toUpperCase()},
  ]))});
  assert.equal(canonical.id, id); assert.equal(canonical.lease_id, leaseId);
});

test('malformed UTF8 and transport messages cannot expose secret text', async () => {
  const bytes = Buffer.from(JSON.stringify([validJob])); bytes[bytes.indexOf('delivered')] = 0xff;
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(new Response(bytes))}), {code: 'response_malformed'});
  const marker = 'fixture-private-token-never-echo';
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: async () => { throw new Error(marker); }}), error => {
    assert.equal(error.code, 'claim_network_failed'); assert.equal(JSON.stringify(error).includes(marker), false); assert.equal(error.message.includes(marker), false); return true;
  });
});

test('invalid credential shapes refuse before a request', async () => {
  for (const key of [null, ' ', 'fixture\nkey', 'fixture\u0000key', 'x'.repeat(4097)]) {
    await assert.rejects(claimConfirmedWelcome({serviceRoleKey: key, limit: 1, fetchImpl: () => assert.fail('network')}), {code: 'missing_service_role_key'});
    await assert.rejects(finishConfirmedWelcome({serviceRoleKey: key, id, leaseId, outcome: 'failed', providerId: null, fetchImpl: () => assert.fail('network')}), {code: 'missing_service_role_key'});
  }
});

test('finish hanging streamed body stops and cancels at the absolute deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let cancelled = false;
  const response = new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('n')); }, cancel() { cancelled = true; }}));
  const rejected = assert.rejects(finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome: 'failed', providerId: null, fetchImpl: mockFetch(response)}),
    {code: 'finish_timeout', ambiguous: true});
  await flushMicrotasks(); t.mock.timers.tick(10000); await rejected; assert.equal(cancelled, true);
});

test('fetch delay consumes the same ten-second body budget without resetting it', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let cancelled = false, settled = false;
  const response = new Response(new ReadableStream({cancel() { cancelled = true; }}));
  const rejected = assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1,
    fetchImpl: () => new Promise(resolve => setTimeout(() => resolve(response), 6000))}), {code: 'claim_timeout', ambiguous: true}).then(() => { settled = true; });
  t.mock.timers.tick(6000); await flushMicrotasks(); t.mock.timers.tick(3999); await flushMicrotasks(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected; assert.equal(cancelled, true);
});

test('invalid later DTO or recipient prevents every provider send in the whole batch', async () => {
  const {processWelcomeOutbox} = await import('../resend-outbox.mjs');
  const env = {EMAIL_AUTOMATION_ENABLED: 'true', SUPABASE_URL: SUPABASE_ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey, RESEND_API_KEY: 'fixture-send-only'};
  const second = {...validJob, id: '22222222-1234-4123-8123-123456789abc', lease_id: '33333333-1234-4123-8123-123456789abc'};
  for (const invalid of [{...second, recipient: 'bad'}, {...second, recipient: 'x@y.com\r\nBcc: z@y.com'}, {...second, brand_slug: 'third-brand'}, {...second, template: 'invoice'}, {...second, extra: 'fixture-private'}]) {
    let calls = 0;
    await assert.rejects(processWelcomeOutbox({env, limit: 2, fetchImpl: async url => {
      calls++; assert.equal(url, `${SUPABASE_ORIGIN}/rest/v1/rpc/claim_confirmed_welcome`); return Response.json([validJob, invalid]);
    }}), /email_queue_receipt_invalid/);
    assert.equal(calls, 1);
  }
});

test('endless zero-byte frames cannot evade finite response bounds', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({pull(controller) { controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled = true; }}));
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey, limit: 1, fetchImpl: mockFetch(response)}), {code: 'response_too_large'});
  assert.equal(cancelled, true);
});

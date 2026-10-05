import test from 'node:test';
import assert from 'node:assert/strict';
import {healthRequest, requireStatus} from '../scripts/health-request.mjs';

test('read-only health requests retry one transient response and close its body', async () => {
  const attempts = []; let cancelled = false;
  const response = await healthRequest('https://example.invalid', {}, async (_, options) => {
    attempts.push(options);
    return attempts.length === 1 ? new Response(new ReadableStream({cancel() {cancelled = true;}}), {status: 503}) : new Response('{}');
  });
  assert.equal(response.status, 200); assert.equal(attempts.length, 2); assert.equal(cancelled, true);
  assert.ok(attempts.every(options => options.redirect === 'manual' && options.signal instanceof AbortSignal));
});
test('maintenance mutations are never retried after either a server error or lost response', async () => {
  for (const failure of ['response', 'network']) {
    let attempts = 0;
    const operation = healthRequest('https://example.invalid', {method: 'POST'}, async () => {
      attempts++; if (failure === 'network') throw Error('Lost response'); return new Response('{}', {status: 503});
    });
    if (failure === 'network') await assert.rejects(operation, /Lost response/);
    else assert.equal((await operation).status, 503);
    assert.equal(attempts, 1);
  }
});
test('unavailable or redirected endpoints cannot pass required health status', () => {
  requireStatus(new Response('{}'), 200);
  for (const status of [301, 401, 500, 503]) {
    assert.throws(() => requireStatus(new Response('{}', {status}), 200), {code: `HTTP_${status}_EXPECTED_200`});
  }
  assert.throws(() => requireStatus(new Response('{}', {status: 400}), 401), {code: 'HTTP_400_EXPECTED_401'});
});

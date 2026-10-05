import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {createOwnedGatewayFromEnv} from '../infra/railway/runtime/owned-gateway-assembly.mjs';

const env = {
  APIWILD_OWNED_GATEWAY_ENABLED: 'true', APIWILD_BILLING_MODE: 'test',
  SUPABASE_SECRET_KEY: 'sb_secret_syntheticFixtureOnly000000',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_syntheticFixtureOnly000000',
};

test('owned gateway rejects absent and malformed credentials with 401 before body validation or external calls', async () => {
  let calls = 0;
  const gateway = createOwnedGatewayFromEnv({env, catalog: {models: []}, fetchImpl: async () => {
    calls++; throw Error('Unauthenticated requests must not reach a dependency');
  }});
  const server = createServer((req, res) => gateway.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const authorization of [undefined, 'Bearer invalid', 'Basic invalid']) {
      for (const [method, path] of [['GET', '/api/gateway'], ['GET', '/api/usage'],
        ['GET', '/api/keys'], ['GET', '/api/gateway/keys'], ['POST', '/api/gateway'],
        ['POST', '/v1/chat/completions'], ['POST', '/api/keys']]) {
        const result = await new Promise((resolve, reject) => {
          const req = request({hostname: '127.0.0.1', port: server.address().port, method, path,
            headers: {host: 'apiwild.com', ...(authorization ? {authorization} : {}),
              ...(method === 'POST' ? {'content-type': 'application/json'} : {})}}, res => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
          });
          req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
        });
        assert.equal(result.status, 401, `${method} ${path}: ${authorization ?? 'absent'}`);
        assert.match(result.headers['cache-control'], /no-store/);
        assert.equal(JSON.parse(result.body).automaticRetry, false);
      }
    }
    assert.equal(calls, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {runDailyHealth} from '../scripts/daily-health.mjs';

function fixture({active = false, count = 39, responses = {}, dnsFailure = false} = {}) {
  const models = Array.from({length: count}, (_, i) => ({model_name: `model-${i}`}));
  const calls = [];
  const json = (value, status = 200) => Response.json(value, {status});
  const defaults = {
    '/health/live': () => json({alive: true, ready: false}),
    '/api/supabase-config': () => json({url: 'https://yautmilnpllojugpmfgy.supabase.co', publishableKey: 'sb_publishable_fixture'}),
    '/api/models': () => json({models, inferenceAvailable: active}),
    '/api/gateway/config': () => json({inferenceEnabled: active, streaming: true, streamingMode: 'buffered-after-settlement', functionCalling: true, nativeStreaming: false, externalTools: false,
      modes: {chat: active, code: false, research: false}, models: active ? [{model: 'model-0', capability: 'chat', maxOutputTokens: 512, supportsTools: false}] : []}),
    '/health/ready': () => json({ready: active, phase: 'launch-preparation', blockers: active ? [] : ['fixture-unaccepted-delivery'], checks: {}}, active ? 200 : 503),
  };
  const dependencies = {
    request: async (url, options = {}) => {
      calls.push({url, options});
      const path = new URL(url).pathname;
      if (responses[path]) return responses[path]();
      if (defaults[path]) return defaults[path]();
      if (path.endsWith('/support-inbound/health')) return json({status: 'ok'});
      if (path.startsWith('/api/') || path.startsWith('/v1/')) return json({error: 'Authentication required.'}, 401);
      return new Response('<title>API WILD</title>');
    },
    mx: async host => {
      if (dnsFailure) throw Object.assign(new Error('private resolver details'), {code: 'ENOTFOUND'});
      return host === 'apiwild.com' ? [{priority: 10, exchange: 'inbound-smtp.us-east-1.amazonaws.com.'}] : [{priority: 10, exchange: 'feedback-smtp.us-east-1.amazonses.com'}];
    },
    txt: async host => {
      if (host === 'send.apiwild.com') return [['v=spf1 include:amazonses.com ~all']];
      if (host.startsWith('resend._domainkey.')) return [['v=DKIM1; p=fixture-public-key']];
      if (host.startsWith('_dmarc.')) return [['v=DMARC1; p=none;']];
      throw Error('Unexpected DNS request');
    },
    now: () => new Date('2026-10-05T12:00:00.000Z'),
  };
  return {calls, dependencies};
}

test('healthy preparation is operationally passing but explicitly launch-blocked', async () => {
  const f = fixture(); const result = await runDailyHealth(f.dependencies);
  assert.equal(result.operationalHealthy, true); assert.equal(result.launchReady, false); assert.equal(result.exitCode, 0);
  assert.equal(result.launchBlockerCount, 1); assert.match(result.report, /launchReady: false\nLAUNCH BLOCKED/);
  assert.ok(result.checks.every(check => check.ok));
  assert.ok(f.calls.every(call => Object.keys(call.options).length === 0));
  assert.ok(f.calls.every(call => !call.url.includes('maintenance') && !call.url.endsWith('/chat/completions')));
});

test('strict launch check fails preparation even though every operational check passes', async () => {
  const result = await runDailyHealth({...fixture().dependencies, requireLaunchReady: true});
  assert.equal(result.operationalHealthy, true); assert.equal(result.launchReady, false); assert.equal(result.exitCode, 1);
});

test('strict launch passes only a coherent active catalog, routes and accepted readiness', async () => {
  const result = await runDailyHealth({...fixture({active: true}).dependencies, requireLaunchReady: true});
  assert.equal(result.operationalHealthy, true); assert.equal(result.launchReady, true); assert.equal(result.exitCode, 0);
  assert.equal(result.launchBlockerCount, 0); assert.match(result.report, /LAUNCH READY/);
});

test('catalog size can change without inventing a three-model or 39-model readiness gate', async () => {
  for (const count of [1, 12, 40]) {
    const result = await runDailyHealth(fixture({count}).dependencies);
    assert.equal(result.operationalHealthy, true); assert.equal(result.launchReady, false);
  }
});

test('unavailable customer reads and broken DNS still fail operational health', async () => {
  for (const input of [{responses: {'/v1/usage': () => Response.json({ready: false}, {status: 503})}}, {dnsFailure: true}]) {
    const result = await runDailyHealth(fixture(input).dependencies);
    assert.equal(result.operationalHealthy, false); assert.equal(result.exitCode, 1); assert.equal(result.launchReady, false);
    assert.doesNotMatch(result.report, /private resolver details/);
  }
});

test('readiness status, blockers and availability must agree; no response body can mark launch ready alone', async () => {
  for (const ready of [
    () => Response.json({ready: true, blockers: []}),
    () => Response.json({ready: false, blockers: ['fixture-blocker']}),
    () => Response.json({ready: false, blockers: []}, {status: 503}),
    () => Response.json({ready: false}, {status: 503}),
    () => new Response('private upstream error', {status: 503}),
  ]) {
    const result = await runDailyHealth(fixture({responses: {'/health/ready': ready}}).dependencies);
    assert.equal(result.operationalHealthy, false); assert.equal(result.launchReady, false); assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.report, /private upstream error/);
  }
});

test('old gateway contract, unknown models or disabled-but-listed routes cannot pass', async () => {
  const inactive = {inferenceEnabled: false, streaming: true, streamingMode: 'buffered-after-settlement', functionCalling: true, nativeStreaming: false, externalTools: false, modes: {chat: false, code: false, research: false}, models: []};
  for (const config of [
    {models: [{}, {}, {}], ready: {chat: false, code: false, research: false, voice: false}},
    {...inactive, inferenceEnabled: true, modes: {chat: true, code: false, research: false}, models: [{model: 'unknown-model', capability: 'chat'}]},
    {...inactive, models: [{model: 'model-0', capability: 'chat'}]},
    {...inactive, modes: {chat: false, code: false}},
    {...inactive, streamingMode: 'native'},
    {...inactive, externalTools: true},
  ]) {
    const result = await runDailyHealth(fixture({responses: {'/api/gateway/config': () => Response.json(config)}}).dependencies);
    assert.equal(result.operationalHealthy, false); assert.equal(result.launchReady, false);
  }
});

test('active readiness cannot hide another failed operational check', async () => {
  const result = await runDailyHealth({...fixture({active: true, responses: {'/login': () => new Response('unavailable', {status: 503})}}).dependencies, requireLaunchReady: true});
  assert.equal(result.launchReady, false); assert.equal(result.exitCode, 1);
});

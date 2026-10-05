import {resolveMx, resolveTxt} from 'node:dns/promises';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {spfIncludesProvider} from './spf-health.mjs';
import {healthRequest, requireStatus} from './health-request.mjs';
import {assertLiveness, assertModelCatalog, assertRuntimeConfig, waitForDeployment} from './owned-health-contract.mjs';

const site = 'https://apiwild.com';
const support = 'https://yautmilnpllojugpmfgy.supabase.co/functions/v1/support-inbound';
const pages = ['/', '/signup', '/login', '/forgot-password', '/auth/complete', '/pricing', '/models', '/console/chat', '/console/code', '/console/research'];
const protectedPaths = ['/api/account', '/api/workspace', '/api/billing', '/api/usage', '/api/keys', '/api/gateway', '/api/gateway/keys', '/api/research/tools', '/v1/models', '/v1/usage'];
function requireValue(ok) { if (!ok) throw Object.assign(new Error('Health contract mismatch.'), {code: 'CONTRACT_MISMATCH'}); }

// Dependencies are injected for offline tests. Production probes never carry a
// customer/provider credential and never invoke a payment, inference or mutation.
export async function runDailyHealth({request = healthRequest, mx = resolveMx, txt = resolveTxt, requireLaunchReady = false,
  expectedCommit, deploymentWait = waitForDeployment, now = () => new Date()} = {}) {
  const checks = [];
  let catalogIds, availability, readiness;
  async function check(name, fn) {
    try { await fn(); checks.push({name, ok: true}); }
    catch (error) { checks.push({name, ok: false, code: /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'CHECK_FAILED'}); }
  }
  async function json(path, status = 200) {
    const response = await request(site + path);
    requireStatus(response, status);
    requireValue(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''));
    return response.json();
  }
  if (expectedCommit !== undefined) await check('Expected Railway deployment active', () => deploymentWait({site, expectedCommit, request}));
  for (const path of pages) {
    await check(`Page ${path}`, async () => {
      const response = await request(site + path); requireStatus(response, 200);
      requireValue((await response.text()).includes('API WILD'));
    });
  }
  await check('Service liveness', async () => assertLiveness(await json('/health/live')));
  await check('Public auth configuration', async () => {
    const body = await json('/api/supabase-config');
    requireValue(typeof body.url === 'string' && new URL(body.url).origin === 'https://yautmilnpllojugpmfgy.supabase.co');
    requireValue(typeof body.publishableKey === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(body.publishableKey));
  });
  await check('Public model catalogue', async () => {
    catalogIds = assertModelCatalog(await json('/api/models'));
  });
  for (const path of protectedPaths) {
    await check(`Authentication boundary ${path}`, async () => requireStatus(await request(site + path), 401));
  }
  await check('Gateway availability metadata', async () => {
    const body = await json('/api/gateway/config');
    assertRuntimeConfig(body, catalogIds ?? new Set(), expectedCommit);
    availability = body;
  });
  await check('Launch readiness contract', async () => {
    const response = await request(site + '/health/ready');
    requireValue(/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || ''));
    const body = await response.json();
    requireValue(typeof body.ready === 'boolean' && Array.isArray(body.blockers)
      && body.blockers.every(blocker => typeof blocker === 'string' && blocker.length > 0 && blocker.length <= 160));
    if (body.ready) {
      requireStatus(response, 200); requireValue(body.blockers.length === 0 && availability?.inferenceConfigured === true);
    } else {
      requireStatus(response, 503); requireValue(body.blockers.length > 0);
    }
    readiness = body;
  });
  await check('Support receiver health', async () => {
    const response = await request(support + '/health'); requireStatus(response, 200);
    requireValue((await response.json()).status === 'ok');
  });
  await check('Support incoming MX', async () => {
    const records = await mx('apiwild.com');
    // Accept the verified Mailu cutover or the retained Resend rollback target.
    requireValue(records.length > 0 && records.every(row =>
      ['mail.apiwild.com', 'inbound-smtp.us-east-1.amazonaws.com'].includes(row.exchange.toLowerCase().replace(/\.$/, '')) && row.priority === 10));
  });
  await check('Resend outgoing MX', async () => requireValue((await mx('send.apiwild.com')).some(row => row.exchange.replace(/\.$/, '') === 'feedback-smtp.us-east-1.amazonses.com')));
  await check('Resend SPF', async () => requireValue(await spfIncludesProvider('send.apiwild.com', 'amazonses.com', txt)));
  await check('Resend DKIM', async () => requireValue((await txt('resend._domainkey.apiwild.com')).some(row => /p=\S+/.test(row.join('')))));
  await check('DMARC record', async () => requireValue((await txt('_dmarc.apiwild.com')).some(row => row.join('').startsWith('v=DMARC1;'))));

  const operationalHealthy = checks.every(check => check.ok);
  const launchReady = operationalHealthy && readiness?.ready === true && availability?.inferenceConfigured === true;
  const launchBlockerCount = readiness?.blockers.length ?? null;
  // Only fixed check labels, booleans, counts and sanitized error codes are logged.
  // Availability is an observation; no checks are silently waived to pass launch.
  const report = ['API WILD operational health and launch readiness', now().toISOString(),
    `operationalHealthy: ${operationalHealthy}`, `launchReady: ${launchReady}`,
    `LAUNCH ${launchReady ? 'READY' : 'BLOCKED'}${launchBlockerCount === null ? ' (readiness could not be verified)' : ` (${launchBlockerCount} reported blockers)`}`,
    ...checks.map(check => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.code ? ` (${check.code})` : ''}`)].join('\n');
  return {checks, operationalHealthy, launchReady, launchBlockerCount, report,
    exitCode: operationalHealthy && (!requireLaunchReady || launchReady) ? 0 : 1};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--require-launch-ready')) {
    console.error('Usage: node scripts/daily-health.mjs [--require-launch-ready]'); process.exitCode = 2;
  } else {
    const result = await runDailyHealth({requireLaunchReady: args.includes('--require-launch-ready'), expectedCommit: process.env.APIWILD_EXPECTED_COMMIT});
    console.log(result.report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.report + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `operational-healthy=${result.operationalHealthy}\nlaunch-ready=${result.launchReady}\n`);
    process.exitCode = result.exitCode;
  }
}

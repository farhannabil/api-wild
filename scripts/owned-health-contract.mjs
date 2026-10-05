import {setTimeout as delay} from 'node:timers/promises';
import {healthRequest, requireStatus} from './health-request.mjs';

const sha = /^[a-f0-9]{40}$/;
const capabilities = ['chat', 'code', 'research', 'voice', 'transcribe', 'speak'];
const fail = code => { throw Object.assign(new Error('Owned runtime health contract failed.'), {code}); };
const requireValue = (value, code) => { if (!value) fail(code); };

function assertPublic(value) {
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      requireValue(!/supplier|upstream|secret|api.?key|provider.?budget|offer_id|^fx$/i.test(key), 'PRIVATE_RUNTIME_FIELD');
      visit(child);
    }
  };
  visit(value);
  requireValue(!/sb_secret_|whsec_|Bearer |\b(?:sk|rk)_(?:live|test)_/.test(JSON.stringify(value)), 'PRIVATE_RUNTIME_VALUE');
}

export function assertLiveness(value) {
  requireValue(value?.alive === true && value.ready === false && value.phase === 'railway-preparation', 'INVALID_RUNTIME_LIVENESS');
}

export function assertModelCatalog(value) {
  requireValue(value?.schemaVersion === 1 && value.authority === 'apiwild-owned-runtime'
    && value.source === 'apiwild-approved-retail' && Array.isArray(value.models)
    && value.models.length > 0 && value.count === value.models.length, 'INVALID_OWNED_CATALOG');
  assertPublic(value);
  const ids = new Set();
  for (const model of value.models) {
    requireValue(typeof model.id === 'string' && model.id.length > 0 && !ids.has(model.id), 'INVALID_CATALOG_MODEL');
    ids.add(model.id);
    requireValue(typeof model.callable === 'boolean' && Array.isArray(model.capabilities)
      && model.capabilities.every(item => capabilities.includes(item))
      && model.callable === (model.capabilities.length > 0), 'INVALID_MODEL_AVAILABILITY');
    requireValue(model.pricing?.currency === 'USD' && model.pricing.unit === 'per_million_tokens'
      && [model.pricing.input, model.pricing.output].every(rate => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0), 'INVALID_RETAIL_PRICE');
  }
  return ids;
}

export function assertRuntimeConfig(value, catalog, expectedCommit) {
  requireValue(value?.schemaVersion === 1 && value.authority === 'apiwild-owned-runtime'
    && sha.test(value.deploymentCommit || '') && typeof value.enabled === 'boolean'
    && value.inferenceConfigured === value.enabled && value.currency === 'usd'
    && typeof value.rateVersion === 'string' && value.rateVersion.length > 0
    && value.streaming === false && value.externalTools === false, 'INVALID_OWNED_RUNTIME');
  if (expectedCommit !== undefined) {
    requireValue(sha.test(expectedCommit || ''), 'INVALID_EXPECTED_COMMIT');
    requireValue(value.deploymentCommit === expectedCommit, 'EXPECTED_DEPLOYMENT_NOT_ACTIVE');
  }
  const ids = assertModelCatalog({...value, source: 'apiwild-approved-retail', count: value.models?.length});
  requireValue(ids.size === catalog.size && [...ids].every(id => catalog.has(id)), 'CATALOG_CONFIG_MISMATCH');
  requireValue(capabilities.every(capability => typeof value.ready?.[capability] === 'boolean'
    && value.ready[capability] === value.models.some(model => model.capabilities.includes(capability))), 'INVALID_CAPABILITY_AVAILABILITY');
  requireValue(value.enabled === value.models.some(model => model.callable), 'INVALID_INFERENCE_AVAILABILITY');
}

// A successful build is not proof Railway has switched its running container.
// Poll only public read-only metadata, then run the actual route assertions.
export async function waitForDeployment({site, expectedCommit, timeoutMs = 600000,
  intervalMs = 10000, request = healthRequest, now = Date.now, sleep = delay}) {
  requireValue(sha.test(expectedCommit || ''), 'INVALID_EXPECTED_COMMIT');
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 600000
    && Number.isInteger(intervalMs) && intervalMs > 0 && intervalMs <= 30000, 'INVALID_DEPLOYMENT_WAIT');
  const deadline = now() + timeoutMs;
  do {
    let response;
    try {
      response = await request(site + '/api/gateway/config');
      requireStatus(response, 200);
      const value = await response.json();
      if (value?.authority === 'apiwild-owned-runtime' && value.schemaVersion === 1
        && value.deploymentCommit === expectedCommit) return;
    } catch { /* A boot/redeploy may be briefly unavailable; never count it as success. */ }
    finally { if (response && !response.bodyUsed) await response.body?.cancel().catch(()=>{}); }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  } while (now() <= deadline);
  fail('EXPECTED_DEPLOYMENT_NOT_ACTIVE');
}

// Owned-runtime discovery. Only approved customer prices cross this boundary.
import {createRetailTokenPricing} from './retail-token-pricing.mjs';
import {exactInteger} from './supabase-gateway-rpc.mjs';

const snapshots = new WeakSet(), adapters = new WeakSet();
const paths = ['/api/models', '/api/gateway/config'];
const capabilities = ['chat', 'code', 'research'];
const text = value => {
  if (typeof value !== 'string' || !value.length || value.length > 160 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid discovery catalogue.');
  return value;
};
const rate = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000) throw Error('Invalid retail discovery rate.');
  return value;
};
const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

export const isOwnedDiscoverySnapshot = value => snapshots.has(value);
export const isOwnedDiscoveryHttp = value => adapters.has(value);
export const isOwnedDiscoveryPath = value => typeof value === 'string' && paths.includes(value.split('?')[0]);

export function createOwnedDiscoverySnapshot({catalog, routes = [], rateVersion = 'inactive', deploymentCommit = null}) {
  if (!Array.isArray(catalog?.models) || catalog.models.length > 2000 || !Array.isArray(routes) || routes.length > 1000) throw Error('Invalid discovery catalogue.');
  text(rateVersion);
  const pricing = createRetailTokenPricing({models: catalog.models, rateVersion});
  const seen = new Set();
  const models = catalog.models.filter(row => row.apiwild_selling_price?.approved === true).map(row => {
    const id = text(row.model_name), p = row.apiwild_selling_price;
    if (seen.has(id) || p.currency !== 'USD' || p.unit !== 'per_million_tokens') throw Error('Invalid discovery catalogue.');
    seen.add(id);
    return {id, name: id, creator: text(row.creator), pricing: {
      currency: 'USD', unit: 'per_million_tokens', input: rate(p.input), output: rate(p.output),
      processing: text(p.processing), inputCache: text(p.input_cache),
      // Conditional rates are advertised only as references, never selected by
      // this read-only API or represented as an active tariff.
      conditionalPricing: Boolean(p.peak || p.long_context || p.tier_schedule),
    }, callable: false, capabilities: []};
  });
  const byId = new Map(models.map(row => [row.id, row]));
  const active = new Set();
  for (const route of routes) {
    const model = byId.get(route.model);
    if (!model || !pricing.models.includes(route.model) || !capabilities.includes(route.capability)) throw Error('Unverified discovery route.');
    exactInteger(route.maxOutputTokens, 1, 32768);
    const key = route.model + ':' + route.capability;
    if (active.has(key)) throw Error('Duplicate discovery route.');
    active.add(key); model.callable = true; model.capabilities.push(route.capability);
  }
  const ready = Object.fromEntries([...capabilities, 'voice', 'transcribe', 'speak'].map(mode => [mode, routes.some(route => route.capability === mode)]));
  const shared = {schemaVersion: 1, authority: 'apiwild-owned-runtime'};
  const snapshot = freeze({
    catalog: {...shared, source: 'apiwild-approved-retail', count: models.length, models},
    config: {...shared, deploymentCommit: typeof deploymentCommit === 'string' && /^[a-f0-9]{40}$/.test(deploymentCommit) ? deploymentCommit : null,
      enabled: routes.length > 0, inferenceConfigured: routes.length > 0,
      ready, currency: 'usd', rateVersion, streaming: false, externalTools: false, models},
    v1Models: {object: 'list', data: models.map(model => ({id: model.id, object: 'model', owned_by: model.creator,
      available: model.callable, pricing: model.pricing})), rate_version: rateVersion, inference_available: routes.length > 0},
  });
  snapshots.add(snapshot);
  return snapshot;
}

export function createOwnedDiscoveryHttp({snapshot}) {
  if (!isOwnedDiscoverySnapshot(snapshot)) throw Error('Invalid discovery snapshot.');
  const adapter = Object.freeze({async handle(req, res) {
    const send = (status, value) => {
      res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); req.resume();
    };
    if (req.headers.host !== 'apiwild.com' || Object.keys(req.headers).some(name => name.toLowerCase().startsWith('oai-authenticated-'))
        || (req.headers.origin && req.headers.origin !== 'https://apiwild.com')) return send(403, {error: 'Invalid discovery origin.'});
    if (!paths.includes(req.url)) return send(400, {error: 'Invalid discovery path.'});
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, {error: 'Read-only discovery route.'});
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) return send(400, {error: 'Discovery requests must not have a body.'});
    return send(200, req.url === '/api/models' ? snapshot.catalog : snapshot.config);
  }});
  adapters.add(adapter); return adapter;
}

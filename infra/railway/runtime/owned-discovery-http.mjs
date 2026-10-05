// Owned-runtime discovery. Only approved customer prices cross this boundary.
import {createRetailTokenPricing} from './retail-token-pricing.mjs';
import {exactInteger} from './supabase-gateway-rpc.mjs';
import {RESEARCH_TOOL_METADATA} from './research-tools.mjs';

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

export function createOwnedDiscoverySnapshot({catalog, routes = [], rateVersion = 'inactive', deploymentCommit = null, tierPolicy, workspaceToolsEnabled = false}) {
  if (!Array.isArray(catalog?.models) || catalog.models.length > 2000 || !Array.isArray(routes) || routes.length > 1000) throw Error('Invalid discovery catalogue.');
  text(rateVersion);
  const pricing = createRetailTokenPricing({models: catalog.models, rateVersion, tierPolicy});
  const seen = new Set();
  const models = catalog.models.filter(row => row.apiwild_selling_price?.approved === true).map(row => {
    const id = text(row.model_name), p = row.apiwild_selling_price;
    if (seen.has(id) || p.currency !== 'USD' || p.unit !== 'per_million_tokens') throw Error('Invalid discovery catalogue.');
    seen.add(id);
    const tier = raw => raw == null ? null : Object.fromEntries(['threshold_input_tokens','input','output','cache_read','cache_write']
      .filter(key => Object.hasOwn(raw, key)).map(key => [key, key === 'threshold_input_tokens' ? exactInteger(raw[key],1,10000000) : rate(raw[key])]));
    return {id, name: id, creator: text(row.creator), pricing: {
      currency: 'USD', unit: 'per_million_tokens', input: rate(p.input), output: rate(p.output),
      processing: text(p.processing), inputCache: text(p.input_cache),
      // Conditional rates are advertised only as references, never selected by
      // this read-only API or represented as an active tariff.
      conditionalPricing: Boolean(p.peak || p.long_context || p.tier_schedule),
      peak: tier(p.peak), longContext: tier(p.long_context), tierSchedule: p.tier_schedule == null ? null : text(p.tier_schedule),
    }, callable: false, capabilities: [], supportsTools: false, toolCapabilities: []};
  });
  const byId = new Map(models.map(row => [row.id, row]));
  const active = new Set(), configured = [];
  for (const route of routes) {
    const model = byId.get(route.model);
    if (!model || !pricing.models.includes(route.model) || !capabilities.includes(route.capability)) throw Error('Unverified discovery route.');
    exactInteger(route.maxOutputTokens, 1, 32768);
    if (route.supportsTools !== undefined && typeof route.supportsTools !== 'boolean') throw Error('Unverified discovery route.');
    const key = route.model + ':' + route.capability;
    if (active.has(key)) throw Error('Duplicate discovery route.');
    active.add(key);
    configured.push(Object.freeze({model:route.model,capability:route.capability,supportsTools:route.supportsTools === true,
      conditional:model.pricing.processing === 'off_peak'}));
  }
  freeze(models); Object.freeze(configured);
  const shared = {schemaVersion: 1, authority: 'apiwild-owned-runtime'};
  const commit = typeof deploymentCommit === 'string' && /^[a-f0-9]{40}$/.test(deploymentCommit) ? deploymentCommit : null;
  // A running process can outlive its accepted conditional-price window. Read
  // availability afresh without choosing a tariff or changing stored requests.
  const read = () => {
    const eligible = configured.filter(route => !route.conditional || tierPolicy?.canAdmit(route.model));
    const current = models.map(model => {
      const routes = eligible.filter(route => route.model === model.id);
      const toolCapabilities = routes.filter(route => route.supportsTools).map(route => route.capability);
      return {...model,callable:routes.length > 0,capabilities:routes.map(route=>route.capability),supportsTools:toolCapabilities.length > 0,toolCapabilities};
    });
    const ready = Object.fromEntries([...capabilities, 'voice', 'transcribe', 'speak'].map(mode => [mode, eligible.some(route => route.capability === mode)]));
    return freeze({
      catalog: {...shared, source: 'apiwild-approved-retail', count: current.length, models:current},
      config: {...shared, deploymentCommit:commit, enabled:eligible.length > 0, inferenceConfigured:eligible.length > 0,
        ready,currency:'usd',rateVersion,streaming:true,streamingMode:'buffered-after-settlement',functionCalling:true,
        nativeStreaming:false,externalTools:false,models:current,
        ...(workspaceToolsEnabled?{workspaceTools:RESEARCH_TOOL_METADATA,browserVoice:{dictation:'browser-dependent',readAloud:'browser-dependent',audioApi:false}}:{})},
      v1Models: {object:'list',data:current.map(model=>({id:model.id,object:'model',owned_by:model.creator,
        available:model.callable,supportsTools:model.supportsTools,pricing:model.pricing})),rate_version:rateVersion,inference_available:eligible.length > 0},
    });
  };
  const snapshot = Object.freeze({read,get catalog(){return read().catalog;},get config(){return read().config;},get v1Models(){return read().v1Models;}});
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
    const current = snapshot.read();
    return send(200, req.url === '/api/models' ? current.catalog : current.config);
  }});
  adapters.add(adapter); return adapter;
}

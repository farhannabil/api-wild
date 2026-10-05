// SERVER ONLY. A typed transport for the existing five service-only SQL RPCs.
// No table access, arbitrary SQL, credential discovery, financial projection or activation.
import { isCustomerKeyRpc } from './customer-key-rpc.mjs';
export const SUPABASE_ORIGIN = 'https://yautmilnpllojugpmfgy.supabase.co';
export const RPC_NAMES = Object.freeze({ reserve: 'apiwild_gateway_reserve', claim: 'apiwild_gateway_claim',
  finish: 'apiwild_gateway_finish', uncertain: 'apiwild_gateway_uncertain', expire: 'apiwild_gateway_expire' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const CAPABILITIES = ['chat', 'code', 'research', 'voice', 'transcribe', 'speak'];
const STATES = ['reserved', 'executing', 'uncertain', 'succeeded', 'failed', 'cancelled'];
const USD_MAX = 1000000000000;
const CNY_RESERVE_MAX = 50000000;
const MAX_RPC_BYTES = 1200000;
const PRIVATE_PATTERNS = [ /\b(?:sb_secret_|sk-ant-|ghp_|github_pat_|whsec_)[A-Za-z0-9_-]{16,}/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+/, /\baw_(?:live|test)_[a-f0-9]{64}\b/,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/ ];

export class GatewayError extends Error {
  constructor(code, status = 503, ambiguous = false) {
    super(code); this.name = 'GatewayError'; this.code = code; this.status = status; this.ambiguous = ambiguous;
  }
}

export function strictObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length
      || Object.keys(value).some(key => !fields.includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) throw new GatewayError('gateway_invalid_input', 400);
  return value;
}

export function exactInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new GatewayError('gateway_invalid_integer', 400);
  return value;
}

function text(value, max, pattern) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value
      || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) throw new GatewayError('gateway_invalid_input', 400);
  return value;
}
function id(value) { return text(value, 36, UUID); }
function stamp(value) { text(value, 64); if (!Number.isFinite(Date.parse(value))) throw new GatewayError('gateway_invalid_response'); return value; }
function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function sameJson(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

// Strict JSON DTOs, not objects with getters/toJSON/functions or executable configuration.
export function cloneJsonObject(value, maxBytes = MAX_RPC_BYTES) {
  let nodes = 0; let stringBytes = 0; const ancestors = new Set();
  const visit = (input, depth) => {
    if (++nodes > 10000 || depth > 24) throw new GatewayError('gateway_payload_too_large', 413);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { if (!Number.isFinite(input)) throw new GatewayError('gateway_invalid_input', 400); return input; }
    if (typeof input === 'string') {
      stringBytes += Buffer.byteLength(input);
      if (stringBytes > maxBytes) throw new GatewayError('gateway_payload_too_large', 413);
      return input;
    }
    if (!input || typeof input !== 'object' || ancestors.has(input)
        || (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))) throw new GatewayError('gateway_invalid_input', 400);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.getOwnPropertySymbols(input).length || Object.entries(descriptors).some(([key, d]) => !Object.hasOwn(d, 'value')
        || (!d.enumerable && !(Array.isArray(input) && key === 'length')))) throw new GatewayError('gateway_invalid_input', 400);
    if (Array.isArray(input) && (input.length > 10000 || Object.keys(input).length !== input.length
        || Object.keys(input).some((key, index) => key !== String(index)))) throw new GatewayError('gateway_invalid_input', 400);
    ancestors.add(input);
    const output = Array.isArray(input) ? [] : Object.create(null);
    for (const key of Object.keys(input)) {
      stringBytes += Buffer.byteLength(key);
      if (stringBytes > maxBytes) throw new GatewayError('gateway_payload_too_large', 413);
      output[key] = visit(descriptors[key].value, depth + 1);
    }
    ancestors.delete(input); return output;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('gateway_invalid_input', 400);
  const output = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw new GatewayError('gateway_payload_too_large', 413);
  return output;
}

export async function withDeadline(task, timeoutMs) {
  exactInteger(timeoutMs, 1, 30000);
  const controller = new AbortController(); let timer;
  const elapsed = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new GatewayError('gateway_deadline_exceeded', 503, true));
  }, timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(() => task(controller.signal)), elapsed]); }
  finally { clearTimeout(timer); controller.abort(); }
}

function cancel(response) { try { void response?.body?.cancel().catch(() => {}); } catch {} }
async function jsonResponse(response, maxBytes, signal) {
  if (!response || !(response.headers instanceof Headers) || typeof response.status !== 'number'
      || !response.headers.get('content-type')?.toLowerCase().match(/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/)) {
    cancel(response); throw new GatewayError('gateway_invalid_response', 503, true);
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    cancel(response); throw new GatewayError('gateway_response_too_large', 503, true);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GatewayError('gateway_invalid_response', 503, true);
  const abort = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  signal.addEventListener('abort', abort, { once: true });
  let count = 0; const chunks = [];
  try {
    while (true) {
      if (signal.aborted) throw new GatewayError('gateway_deadline_exceeded', 503, true);
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new GatewayError('gateway_invalid_response', 503, true);
      count += value.byteLength;
      if (count > maxBytes) { abort(); throw new GatewayError('gateway_response_too_large', 503, true); }
      chunks.push(value);
    }
    if (signal.aborted) throw new GatewayError('gateway_deadline_exceeded', 503, true);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, count))); }
    catch { throw new GatewayError('gateway_invalid_response', 503, true); }
    return parsed;
  } finally { signal.removeEventListener('abort', abort); try { reader.releaseLock(); } catch {} }
}

function key(value, elevated) {
  text(value, 8192);
  const prefix = elevated ? /^sb_secret_[A-Za-z0-9_-]{16,256}$/ : /^sb_publishable_[A-Za-z0-9_-]{16,256}$/;
  if (prefix.test(value)) return { value, legacy: false };
  const jwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (!jwt.test(value)) throw new GatewayError('gateway_invalid_configuration');
  let claims;
  try { claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')); } catch { throw new GatewayError('gateway_invalid_configuration'); }
  if (claims?.role !== (elevated ? 'service_role' : 'anon') || claims?.ref !== 'yautmilnpllojugpmfgy') throw new GatewayError('gateway_invalid_configuration');
  return { value, legacy: true }; // Shape only; this is not cryptographic validation/acceptance.
}

function reserveInput(raw) {
  strictObject(raw, ['keyId', 'providerBudgetId', 'requestKey', 'payloadHash', 'capability', 'model', 'rateVersion', 'reservedUsdMicros', 'reservedCnyMicros']);
  if (raw.keyId !== null) id(raw.keyId);
  id(raw.providerBudgetId); text(raw.requestKey, 100, /^[A-Za-z0-9_-]{16,100}$/); text(raw.payloadHash, 64, HASH);
  if (!CAPABILITIES.includes(raw.capability)) throw new GatewayError('gateway_invalid_input', 400);
  text(raw.model, 160); text(raw.rateVersion, 160);
  exactInteger(raw.reservedUsdMicros, 1, USD_MAX); exactInteger(raw.reservedCnyMicros, 1, CNY_RESERVE_MAX);
  return { ...raw };
}

const RECORD_FIELDS = ['id', 'user_id', 'key_id', 'provider_budget_id', 'request_key', 'payload_hash', 'capability', 'model', 'rate_version',
  'state', 'version', 'reserved_usd_micros', 'cost_usd_micros', 'reserved_cny_micros', 'cost_cny_micros', 'observed_cny_micros',
  'pricing_bound_exceeded', 'settlement_reference', 'result_json', 'usage_json', 'created_at', 'updated_at', 'expires_at'];
const IMMUTABLE = ['id', 'user_id', 'key_id', 'provider_budget_id', 'request_key', 'payload_hash', 'capability', 'model', 'rate_version', 'reserved_usd_micros', 'reserved_cny_micros'];

export function createGatewayRpc(config) {
  strictObject(config, ['supabaseOrigin', 'secretKey', 'publishableKey', 'billingMode', 'fetchImpl', 'rpcTimeoutMs', 'authTimeoutMs', 'ownerTtlMs', 'keyVerifier', 'retailSettlement']);
  if (config.keyVerifier !== undefined && !isCustomerKeyRpc(config.keyVerifier)) throw new GatewayError('gateway_invalid_key_verifier');
  if(config.retailSettlement!==undefined&&typeof config.retailSettlement!=='boolean')throw new GatewayError('gateway_invalid_configuration');
  const keyVerifier = config.keyVerifier;
  // Exact text, not URL normalization: reject ports, credentials, slashes, encoding and inactive projects.
  if (config.supabaseOrigin !== SUPABASE_ORIGIN || !['live', 'test'].includes(config.billingMode)) throw new GatewayError('gateway_invalid_configuration');
  const secret = key(config.secretKey, true); const publishable = key(config.publishableKey, false);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new GatewayError('gateway_invalid_configuration');
  const rpcTimeoutMs = exactInteger(config.rpcTimeoutMs ?? 12000, 1, 25000);
  const authTimeoutMs = exactInteger(config.authTimeoutMs ?? 5000, 1, 10000);
  const ownerTtlMs = exactInteger(config.ownerTtlMs ?? 60000, 1, 60000);
  const billingMode = config.billingMode;
  const owners = new WeakMap(); const records = new WeakMap();
  const privateValues = [secret.value];
  const rejectPrivate = (value, extra = []) => {
    const serialized = JSON.stringify(value);
    if ([...privateValues, ...extra].some(v => serialized.includes(v)) || PRIVATE_PATTERNS.some(pattern => pattern.test(serialized))) throw new GatewayError('gateway_private_payload_rejected', 503, true);
  };
  const owner = context => {
    const meta = owners.get(context);
    if (!meta || performance.now() >= meta.expires || context.project !== 'apiwild' || context.billingMode !== billingMode) throw new GatewayError('gateway_owner_unverified', 401);
    if (meta.keyContext) keyVerifier.assertContext(meta.keyContext, meta.capability);
    return meta;
  };
  const validRecord = (raw, meta, prior, expected) => {
    try {
      strictObject(raw, [...RECORD_FIELDS,'supplier_pending']);
      if(raw.supplier_pending!==undefined&&typeof raw.supplier_pending!=='boolean')throw new GatewayError('gateway_invalid_response');
      if (RECORD_FIELDS.some(f => !Object.hasOwn(raw, f))) throw new GatewayError('gateway_invalid_response');
      id(raw.id);
      if (raw.user_id !== meta.owner) throw new GatewayError('gateway_invalid_response');
      if (raw.key_id !== null) id(raw.key_id);
      if (meta.keyId && raw.key_id !== meta.keyId) throw new GatewayError('gateway_invalid_response');
      id(raw.provider_budget_id); text(raw.request_key, 100, /^[A-Za-z0-9_-]{16,100}$/); text(raw.payload_hash, 64, HASH);
      if (!CAPABILITIES.includes(raw.capability) || !STATES.includes(raw.state)) throw new GatewayError('gateway_invalid_response');
      text(raw.model, 160); text(raw.rate_version, 160); exactInteger(raw.version);
      exactInteger(raw.reserved_usd_micros, 1, USD_MAX); exactInteger(raw.reserved_cny_micros, 1, CNY_RESERVE_MAX);
      exactInteger(raw.cost_usd_micros, 0, raw.reserved_usd_micros); exactInteger(raw.cost_cny_micros, 0, raw.reserved_cny_micros);
      exactInteger(raw.observed_cny_micros, 0, USD_MAX);
      if (typeof raw.pricing_bound_exceeded !== 'boolean' || (raw.state === 'failed' && raw.cost_usd_micros !== 0)) throw new GatewayError('gateway_invalid_response');
      if ((raw.pricing_bound_exceeded && raw.state !== 'uncertain')
          || (!['succeeded', 'failed'].includes(raw.state) && (raw.cost_usd_micros !== 0 || raw.cost_cny_micros !== 0))
          || (['succeeded', 'failed'].includes(raw.state) && (raw.pricing_bound_exceeded || raw.observed_cny_micros !== raw.cost_cny_micros
              || raw.result_json === null || raw.settlement_reference === null))) throw new GatewayError('gateway_invalid_response');
      if (raw.settlement_reference !== null) text(raw.settlement_reference, 500);
      if (raw.result_json !== null) cloneJsonObject(raw.result_json, 1048576);
      cloneJsonObject(raw.usage_json, 65536);
      for (const field of ['created_at', 'updated_at', 'expires_at']) stamp(raw[field]);
      if (prior && IMMUTABLE.some(f => raw[f] !== prior[f])) throw new GatewayError('gateway_invalid_response');
      if (expected && (raw.key_id !== expected.keyId || raw.provider_budget_id !== expected.providerBudgetId || raw.request_key !== expected.requestKey
          || raw.payload_hash !== expected.payloadHash || raw.capability !== expected.capability || raw.model !== expected.model || raw.rate_version !== expected.rateVersion
          || raw.reserved_usd_micros !== expected.reservedUsdMicros || raw.reserved_cny_micros !== expected.reservedCnyMicros)) throw new GatewayError('gateway_invalid_response');
      rejectPrivate(raw);
      const frozen = deepFreeze(JSON.parse(JSON.stringify(raw)));
      records.set(frozen, { owner: meta.owner }); return frozen;
    } catch { throw new GatewayError('gateway_invalid_response', 503, true); }
  };
  const reference = (context, record) => {
    const meta = owner(context);
    if (!records.has(record) || records.get(record).owner !== meta.owner) throw new GatewayError('gateway_reference_unverified', 400);
    return meta;
  };
  const request = async (url, headers, body, timeout, maxBytes, auth = false, rpcOperation) => {
    if (body !== undefined && Buffer.byteLength(body) > MAX_RPC_BYTES) throw new GatewayError('gateway_payload_too_large', 413);
    try {
      return await withDeadline(async signal => {
        const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body }), signal, redirect: 'error', cache: 'no-store' });
        if (signal.aborted) { cancel(response); throw new GatewayError('gateway_deadline_exceeded', 503, true); }
        if (response?.redirected || (response?.url && response.url !== url)) { cancel(response); throw new GatewayError('gateway_invalid_response', 503, true); }
        if (!response?.ok) {
          if(['reserve','claim','lookupQuote'].includes(rpcOperation)&&/^application\/json(?:\s*;|$)/i.test(response?.headers?.get('content-type')||'')){
            const failure=await jsonResponse(response,8192,signal);
            if(['gateway_customer_limit','gateway_key_limit'].includes(failure?.message))throw new GatewayError(failure.message,402,false);
            if(failure?.message==='gateway_idempotency_conflict')throw new GatewayError('gateway_idempotency_conflict',409,false);
          }
          cancel(response); // Never parse/echo database messages, HTML or upstream credential errors.
          const invalidOwner = auth && [401, 403].includes(response?.status);
          throw new GatewayError(invalidOwner ? 'gateway_owner_unverified' : 'gateway_rpc_unavailable', invalidOwner ? 401 : 503, !auth);
        }
        return jsonResponse(response, maxBytes, signal);
      }, timeout);
    } catch (error) { throw error instanceof GatewayError ? error : new GatewayError('gateway_rpc_unavailable', 503, !auth); }
  };
  const rpc = async (operation, context, parameters, prior, expected) => {
    const meta = owner(context);
    const body = JSON.stringify({ p_owner: meta.owner, ...parameters });
    const headers = { apikey: secret.value, 'content-type': 'application/json', accept: 'application/json', 'content-profile': 'public' };
    if (secret.legacy) headers.authorization = 'Bearer ' + secret.value;
    const value = await request(SUPABASE_ORIGIN + '/rest/v1/rpc/' + (operation==='finish'&&config.retailSettlement?'apiwild_gateway_finish_retail':RPC_NAMES[operation]), headers, body, rpcTimeoutMs, MAX_RPC_BYTES,false,operation);
    rejectPrivate(value);
    const allowed = { reserve: ['fresh', 'record'], claim: ['claimed', 'record'], finish: ['settled', 'replayed', 'code', 'record'], uncertain: ['replayed', 'record'], expire: ['cancelled', 'record'] }[operation];
    try { strictObject(value, allowed); } catch { throw new GatewayError('gateway_invalid_response', 503, true); }
    const flag = { reserve: 'fresh', claim: 'claimed', finish: 'settled', uncertain: 'replayed', expire: 'cancelled' }[operation];
    if (typeof value[flag] !== 'boolean') throw new GatewayError('gateway_invalid_response', 503, true);
    if (operation === 'finish' && value.settled && typeof value.replayed !== 'boolean') throw new GatewayError('gateway_invalid_response', 503, true);
    const record = validRecord(value.record, meta, prior, expected);
    if ((operation === 'reserve' && value.fresh && (record.state !== 'reserved' || record.version !== 0))
        || (operation === 'claim' && value.claimed && (record.state !== 'executing' || record.version !== prior.version + 1))
        || (operation === 'finish' && value.settled && !['succeeded', 'failed'].includes(record.state))
        || (operation === 'finish' && !value.settled && record.state !== 'uncertain')
        || (operation === 'uncertain' && record.state !== 'uncertain')
        || (operation === 'expire' && value.cancelled && record.state !== 'cancelled')) throw new GatewayError('gateway_invalid_response', 503, true);
    if ((prior && record.version < prior.version)
        || (operation === 'finish' && value.settled && !value.replayed && record.version !== prior.version + 1)
        || (operation === 'uncertain' && !value.replayed && (prior.state !== 'executing' || record.version !== prior.version + 1))
        || (operation === 'expire' && value.cancelled && (prior.state !== 'reserved' || record.version !== prior.version + 1))) throw new GatewayError('gateway_invalid_response', 503, true);
    if (operation === 'finish' && value.settled && (record.state !== parameters.p_state
        || record.cost_usd_micros !== parameters.p_cost_usd_micros || record.cost_cny_micros !== parameters.p_cost_cny_micros
        || record.settlement_reference !== parameters.p_settlement_reference || !sameJson(record.result_json, parameters.p_result)
        || !sameJson(record.usage_json, parameters.p_usage))) throw new GatewayError('gateway_invalid_response', 503, true);
    return Object.freeze({ [flag]: value[flag], ...(operation === 'finish' ? { replayed: value.replayed === true } : {}), record });
  };
  const accountRead=async(context,name)=>{const meta=owner(context);const headers={apikey:secret.value,'content-type':'application/json',accept:'application/json'};if(secret.legacy)headers.authorization='Bearer '+secret.value;const value=await request(SUPABASE_ORIGIN+'/rest/v1/rpc/'+name,headers,JSON.stringify({p_owner:meta.owner}),rpcTimeoutMs,16384);rejectPrivate(value);return value;};
  const client = {
    async initializeAccount(context){const v=await accountRead(context,'apiwild_gateway_account_initialize');if(v?.initialized!==true||v.customer_id!==context.customerId||v.billing_mode!==billingMode)throw new GatewayError('gateway_account_unverified');return {initialized:true};},
    async usage(context){const v=await accountRead(context,'apiwild_gateway_usage');strictObject(v,['currency','fundedUsdMicros','spentUsdMicros','reservedUsdMicros','paymentHoldUsdMicros','availableUsdMicros','completedRequests']);if(v.currency!=='USD')throw new GatewayError('gateway_usage_unverified');for(const k of ['fundedUsdMicros','spentUsdMicros','reservedUsdMicros','paymentHoldUsdMicros','availableUsdMicros','completedRequests'])exactInteger(v[k],k==='fundedUsdMicros'?-USD_MAX:0,USD_MAX);return Object.freeze(v);},
    async verifyKeyOwner(raw) {
      strictObject(raw, ['authorization', 'capability']);
      if (!keyVerifier || !CAPABILITIES.includes(raw.capability)) throw new GatewayError('gateway_key_unavailable', 401);
      const keyContext = await keyVerifier.authenticate(raw);
      keyVerifier.assertContext(keyContext, raw.capability);
      id(keyContext.customerId); id(keyContext.keyId);
      if (keyContext.billingMode !== billingMode) throw new GatewayError('gateway_key_unavailable', 401);
      const context = Object.freeze({ project: 'apiwild', billingMode, customerId: keyContext.customerId, keyId: keyContext.keyId });
      owners.set(context, { owner: billingMode + ':supabase:' + keyContext.customerId,
        expires: performance.now() + Math.min(ownerTtlMs, keyVerifier.remainingContextMs(keyContext, raw.capability)),
        keyContext, keyId: keyContext.keyId, capability: raw.capability });
      return context;
    },
    async verifyOwner(raw) {
      strictObject(raw, ['authorization', 'expectedCustomerId']);
      if (raw.expectedCustomerId !== undefined) id(raw.expectedCustomerId);
      const authorization = text(raw.authorization, 8192, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const headers = { apikey: publishable.value, authorization, accept: 'application/json' };
      const user = await request(SUPABASE_ORIGIN + '/auth/v1/user', headers, undefined, authTimeoutMs, 16384, true);
      rejectPrivate(user, [authorization.slice(7)]);
      try {
        id(user?.id); stamp(user.email_confirmed_at);
        if (typeof user.email !== 'string' || !user.email.length || user.is_anonymous !== false
            || (raw.expectedCustomerId !== undefined && raw.expectedCustomerId !== user.id)) throw new GatewayError('gateway_owner_unverified');
      } catch { throw new GatewayError('gateway_owner_unverified', 403); }
      const context = Object.freeze({ project: 'apiwild', billingMode, customerId: user.id });
      owners.set(context, { owner: billingMode + ':supabase:' + user.id, expires: performance.now() + ownerTtlMs });
      return context;
    },
    async lookupQuote(context, raw) {
      const meta=owner(context);
      strictObject(raw,['keyId','requestKey','payloadHash','capability','model']);
      if(raw.keyId!==null)id(raw.keyId);
      text(raw.requestKey,100,/^[A-Za-z0-9_-]{16,100}$/);text(raw.payloadHash,64,HASH);text(raw.model,160);
      if(!CAPABILITIES.includes(raw.capability))throw new GatewayError('gateway_invalid_input',400);
      if(meta.keyId&&(raw.keyId!==meta.keyId||raw.capability!==meta.capability))throw new GatewayError('gateway_key_scope_mismatch',403);
      rejectPrivate(raw);
      const headers={apikey:secret.value,'content-type':'application/json',accept:'application/json','content-profile':'public'};
      if(secret.legacy)headers.authorization='Bearer '+secret.value;
      const value=await request(SUPABASE_ORIGIN+'/rest/v1/rpc/apiwild_gateway_quote_lookup',headers,
        JSON.stringify({p_owner:meta.owner,p_key_id:raw.keyId,p_request_key:raw.requestKey,p_payload_hash:raw.payloadHash,p_capability:raw.capability,p_model:raw.model}),rpcTimeoutMs,8192,false,'lookupQuote');
      try{
        strictObject(value,['found','quote']);if(typeof value.found!=='boolean')throw Error();
        if(!value.found){if(Object.hasOwn(value,'quote'))throw Error();return null;}
        const q=value.quote;strictObject(q,['providerBudgetId','model','rateVersion','reservedUsdMicros','reservedCnyMicros']);
        if(q.model!==raw.model)throw Error();
        reserveInput({...q,...raw});rejectPrivate(q);return deepFreeze({...q});
      }catch{throw new GatewayError('gateway_invalid_response',503,true);}
    },
    reserve(context, raw) {
      const meta = owner(context); const input = reserveInput(raw);
      if (meta.keyId && (input.keyId !== meta.keyId || input.capability !== meta.capability)) throw new GatewayError('gateway_key_scope_mismatch', 403);
      rejectPrivate(input);
      return rpc('reserve', context, { p_key_id: input.keyId, p_provider_budget_id: input.providerBudgetId, p_request_key: input.requestKey,
        p_payload_hash: input.payloadHash, p_capability: input.capability, p_model: input.model, p_rate_version: input.rateVersion,
        p_reserved_usd_micros: input.reservedUsdMicros, p_reserved_cny_micros: input.reservedCnyMicros }, null, input);
    },
    claim(context, record) { reference(context, record); return rpc('claim', context, { p_id: record.id, p_expected_version: record.version }, record); },
    finish(context, record, raw) {
      reference(context, record);
      strictObject(raw, ['state', 'costUsdMicros', 'costCnyMicros', 'settlementReference', 'result', 'usage']);
      if (!['succeeded', 'failed'].includes(raw.state)) throw new GatewayError('gateway_invalid_input', 400);
      exactInteger(raw.costUsdMicros, 0, USD_MAX); exactInteger(raw.costCnyMicros, 0, USD_MAX);
      if (raw.state === 'failed' && raw.costUsdMicros !== 0) throw new GatewayError('gateway_invalid_input', 400);
      text(raw.settlementReference, 500);
      const result = cloneJsonObject(raw.result, 1048576); const usage = cloneJsonObject(raw.usage, 65536);
      rejectPrivate({ result, usage, reference: raw.settlementReference });
      // Send real observed over-bound costs to the SQL freeze path; never clamp native liability.
      return rpc('finish', context, { p_id: record.id, p_expected_version: record.version, p_state: raw.state,
        p_cost_usd_micros: raw.costUsdMicros, p_cost_cny_micros: raw.costCnyMicros, p_settlement_reference: raw.settlementReference,
        p_result: result, p_usage: usage }, record);
    },
    uncertain(context, record) { reference(context, record); return rpc('uncertain', context, { p_id: record.id, p_expected_version: record.version }, record); },
    expire(context, record) { reference(context, record); return rpc('expire', context, { p_id: record.id, p_expected_version: record.version }, record); },
    assertReference(context, record) { reference(context, record); },
    assertDispatchWindow(context, workTimeoutMs) {
      const meta = owner(context);
      exactInteger(workTimeoutMs, 1, 40000);
      // Nonspending admission only: leave time for bounded provider work,
      // verification, finish and one uncertain-hold cleanup. Never extend auth.
      if (meta.expires - performance.now() <= workTimeoutMs + 2 * rpcTimeoutMs + 250) throw new GatewayError('gateway_authority_window_insufficient', 409);
    },
    assertPrivatePayload(value) { rejectPrivate(value); },
  };
  return Object.freeze(client);
}

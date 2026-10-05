// SERVER ONLY. Requires the separately reviewed customer-key SQL RPC migration.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { GatewayError, SUPABASE_ORIGIN, strictObject, exactInteger, withDeadline } from './supabase-gateway-rpc.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPES = ['chat', 'code', 'research', 'voice', 'transcribe', 'speak'];
const MAX = 1000000000000;
const instances = new WeakSet();
export function isCustomerKeyRpc(value) { return instances.has(value); }
export const CUSTOMER_KEY_RPC_NAMES = Object.freeze({ issue: 'apiwild_gateway_key_issue', list: 'apiwild_gateway_key_list', revoke: 'apiwild_gateway_key_revoke', authenticate: 'apiwild_gateway_key_authenticate' });
const reject = (code = 'customer_key_unavailable', status = 403, ambiguous = false) => { throw new GatewayError(code, status, ambiguous); };
const hash = value => createHash('sha256').update(value).digest('hex');
function metadata(value, mode, customerId) {
  strictObject(value, ['id', 'customer_id', 'billing_mode', 'scopes', 'daily_limit_usd_micros', 'total_limit_usd_micros', 'expires_at', 'revoked_at']);
  if (!UUID.test(value.id) || !UUID.test(value.customer_id) || value.billing_mode !== mode || (customerId && customerId !== value.customer_id)) reject('customer_key_invalid_response', 503, true);
  if (!Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 6 || new Set(value.scopes).size !== value.scopes.length || value.scopes.some(s => !SCOPES.includes(s))) reject('customer_key_invalid_response', 503, true);
  exactInteger(value.daily_limit_usd_micros, 0, MAX); exactInteger(value.total_limit_usd_micros, 0, MAX);
  if (value.daily_limit_usd_micros > value.total_limit_usd_micros || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)) || (value.revoked_at !== null && (typeof value.revoked_at !== 'string' || !Number.isFinite(Date.parse(value.revoked_at))))) reject('customer_key_invalid_response', 503, true);
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) });
}
export function createCustomerKeyRpc(config) {
  strictObject(config, ['supabaseOrigin', 'secretKey', 'billingMode', 'verifyOwner', 'fetchImpl', 'timeoutMs']);
  if (config.supabaseOrigin !== SUPABASE_ORIGIN || !['test', 'live'].includes(config.billingMode) || typeof config.verifyOwner !== 'function' || typeof config.secretKey !== 'string' || !/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(config.secretKey)) reject('customer_key_invalid_configuration', 503);
  const mode = config.billingMode, secret = config.secretKey, verifyOwner = config.verifyOwner;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') reject('customer_key_invalid_configuration', 503);
  const timeout = exactInteger(config.timeoutMs ?? 5000, 1, 10000);
  const contexts = new WeakMap();
  async function rpc(operation, parameters) {
    try {
      return await withDeadline(async signal => {
        const response = await fetchImpl(SUPABASE_ORIGIN + '/rest/v1/rpc/' + CUSTOMER_KEY_RPC_NAMES[operation], { method: 'POST', headers: { apikey: secret, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(parameters), redirect: 'error', cache: 'no-store', signal });
        if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) reject('customer_key_rpc_unconfirmed', 503, true);
        const reader = response.body?.getReader(); if (!reader) reject('customer_key_rpc_unconfirmed', 503, true);
        const chunks = []; let bytes = 0;
        const abort = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          for (;;) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 131072) reject('customer_key_rpc_unconfirmed', 503, true); chunks.push(next.value); }
          signal.throwIfAborted(); const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.includes(secret) || /aw_(?:live|test)_[a-f0-9]{64}/.test(raw)) reject('customer_key_private_response_rejected', 503, true);
          return JSON.parse(raw);
        } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
      }, timeout);
    } catch { reject('customer_key_rpc_unconfirmed', 503, true); }
  }
  async function owner(authorization) {
    const context = await verifyOwner({ authorization });
    if (!context || !UUID.test(context.customerId) || context.billingMode !== mode) reject('customer_key_owner_unverified');
    return context.customerId;
  }
  const client = Object.freeze({
    async issue(raw) {
      strictObject(raw, ['authorization', 'scopes', 'dailyLimitUsdMicros', 'totalLimitUsdMicros', 'expiresAt']);
      if (!Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > 6 || new Set(raw.scopes).size !== raw.scopes.length || raw.scopes.some(s => !SCOPES.includes(s))) reject('customer_key_invalid_scopes', 400);
      const scopes = [...raw.scopes]; const daily = exactInteger(raw.dailyLimitUsdMicros, 0, MAX); const total = exactInteger(raw.totalLimitUsdMicros, 0, MAX);
      if (daily > total || typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt)) || Date.parse(raw.expiresAt) <= Date.now() || Date.parse(raw.expiresAt) > Date.now() + 365 * 86400000) reject('customer_key_invalid_limits', 400);
      const expires = new Date(raw.expiresAt).toISOString(); const customerId = await owner(raw.authorization);
      const token = 'aw_' + mode + '_' + randomBytes(32).toString('hex'); const id = randomUUID();
      const row = metadata(await rpc('issue', { p_owner: mode + ':supabase:' + customerId, p_id: id, p_hash: hash(token), p_scopes: scopes, p_daily_limit: daily, p_total_limit: total, p_expires_at: expires }), mode, customerId);
      if (row.id !== id || JSON.stringify(row.scopes) !== JSON.stringify(scopes) || row.daily_limit_usd_micros !== daily || row.total_limit_usd_micros !== total || Date.parse(row.expires_at) !== Date.parse(expires) || row.revoked_at !== null) reject('customer_key_invalid_response', 503, true);
      return Object.freeze({ key: token, metadata: row }); // Revealed once; never sent to storage.
    },
    async list(raw) {
      strictObject(raw, ['authorization']); const customerId = await owner(raw.authorization);
      const rows = await rpc('list', { p_owner: mode + ':supabase:' + customerId });
      if (!Array.isArray(rows) || rows.length > 100) reject('customer_key_invalid_response', 503, true);
      const result = rows.map(r => metadata(r, mode, customerId));
      if (new Set(result.map(r => r.id)).size !== result.length) reject('customer_key_invalid_response', 503, true);
      return Object.freeze(result);
    },
    async revoke(raw) {
      strictObject(raw, ['authorization', 'keyId']); if (!UUID.test(raw.keyId)) reject('customer_key_invalid_input', 400);
      const customerId = await owner(raw.authorization); const row = metadata(await rpc('revoke', { p_owner: mode + ':supabase:' + customerId, p_id: raw.keyId }), mode, customerId);
      if (row.id !== raw.keyId || row.revoked_at === null) reject('customer_key_invalid_response', 503, true);
      return row;
    },
    async authenticate(raw) {
      strictObject(raw, ['authorization', 'capability']);
      const match = typeof raw.authorization === 'string' && raw.authorization.match(/^Bearer (aw_(live|test)_[a-f0-9]{64})$/);
      if (!match || match[2] !== mode || !SCOPES.includes(raw.capability)) reject();
      const row = metadata(await rpc('authenticate', { p_hash: hash(match[1]), p_mode: mode, p_capability: raw.capability }), mode);
      if (row.revoked_at !== null || Date.parse(row.expires_at) <= Date.now() || !row.scopes.includes(raw.capability)) reject();
      const context = Object.freeze({ customerId: row.customer_id, billingMode: mode, keyId: row.id, scopes: row.scopes });
      contexts.set(context, { expires: Math.min(performance.now() + 60000, performance.now() + Date.parse(row.expires_at) - Date.now()) });
      return context;
    },
    assertContext(context, capability) {
      const meta = contexts.get(context); if (!meta || meta.expires <= performance.now() || !context.scopes.includes(capability)) reject();
      return context;
    },
    remainingContextMs(context, capability) {
      this.assertContext(context, capability);
      return Math.max(0, contexts.get(context).expires - performance.now());
    },
  });
  instances.add(client);
  return client;
}

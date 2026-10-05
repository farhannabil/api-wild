// Server-only Subrouter station activation transport. Importing this file does
// not provision credit; callers must first verify the paid Stripe order and
// persist an idempotent outbox entry with an accepted native quota.
const ORIGIN = 'https://apiwild.subrouter.ai';
const PATH = '/api/dist/internal/saas/activate';
const fail = code => Object.assign(new Error(code), {code});
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const codePattern = /^[A-Za-z0-9-]{4,128}$/;
const orderPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function createSubrouterSaasActivation({enabled=false, token, fetchImpl=fetch, timeoutMs=10000}={}) {
  if (!enabled) return async () => { throw fail('subrouter_activation_disabled'); };
  if (typeof token !== 'string' || token.length < 16 || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)
    || typeof fetchImpl !== 'function' || !integer(timeoutMs, 1, 10000)) throw fail('subrouter_activation_unconfigured');
  return async fact => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)
      || Object.keys(fact).sort().join(',') !== 'code,expectedQuota,orderId,packageId,userId'
      || !integer(fact.userId, 1, 2147483647) || !integer(fact.packageId, 1, 2147483647)
      || !codePattern.test(fact.code) || !orderPattern.test(fact.orderId)
      || !integer(fact.expectedQuota, 1, Number.MAX_SAFE_INTEGER)) throw fail('subrouter_activation_invalid_fact');
    const url = ORIGIN + PATH;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: {'X-SubRouter-Saas-Activation-Token': token, 'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({user_id: fact.userId, package_id: fact.packageId, code: fact.code, order_id: fact.orderId}),
      });
      if (!(response instanceof Response) || !response.ok || response.redirected || (response.url && response.url !== url)
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw fail('subrouter_activation_unverified');
      const size = response.headers.get('content-length');
      if (size !== null && (!/^\d+$/.test(size) || Number(size) > 8192)) throw fail('subrouter_activation_unverified');
      const reader = response.body?.getReader();
      if (!reader) throw fail('subrouter_activation_unverified');
      const chunks = []; let total = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array) || (total += value.length) > 8192) throw fail('subrouter_activation_unverified');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const envelope = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, total)));
      const data = envelope?.data;
      if (envelope?.success !== true || !data || data.user_id !== fact.userId || data.package_id !== fact.packageId
        || data.order_id !== fact.orderId || data.quota_redeemed !== fact.expectedQuota
        || typeof data.already_activated !== 'boolean') throw fail('subrouter_activation_unverified');
      return Object.freeze({orderId: fact.orderId, userId: fact.userId, packageId: fact.packageId,
        quotaRedeemed: data.quota_redeemed, alreadyActivated: data.already_activated});
    } catch { throw fail('subrouter_activation_unverified'); }
    finally { try { await response?.body?.cancel(); } catch {} }
  };
}

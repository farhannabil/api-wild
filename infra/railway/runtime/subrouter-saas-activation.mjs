// Server-only implementation of the verified station activation contract.
// No environment discovery, quota conversion, automatic retry or balance API.
import {strictObject, exactInteger, withDeadline} from './supabase-gateway-rpc.mjs';
const ORIGIN = 'https://apiwild.subrouter.ai';
const PATH = '/api/dist/internal/saas/activate';
const fail = code => Object.assign(new Error(code), {code});
const fields = ['userId', 'packageId', 'code', 'orderId', 'expectedQuota'];
export function createSubrouterSaasActivation({enabled=false, token, fetchImpl=fetch, timeoutMs=10000}={}) {
  if (enabled !== true) return async () => { throw fail('subrouter_activation_disabled'); };
  if (typeof token !== 'string' || token.length < 16 || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)
      || typeof fetchImpl !== 'function') throw fail('subrouter_activation_unconfigured');
  exactInteger(timeoutMs, 1, 10000);
  return async raw => {
    let fact;
    try {
      strictObject(raw, fields);
      if (fields.some(f => !Object.hasOwn(raw, f))) throw Error();
      fact = {...raw};
      exactInteger(fact.userId, 1, 2147483647); exactInteger(fact.packageId, 1, 2147483647);
      exactInteger(fact.expectedQuota, 1);
      if (typeof fact.code !== 'string' || typeof fact.orderId !== 'string'
          || !/^[A-Za-z0-9-]{4,128}$/.test(fact.code) || !/^[A-Za-z0-9_-]{1,128}$/.test(fact.orderId)) throw Error();
    } catch { throw fail('subrouter_activation_invalid_fact'); }
    try {
      return await withDeadline(async signal => {
        let response, reader;
        const cancel = () => { try { void (reader?.cancel() ?? response?.body?.cancel())?.catch(() => {}); } catch {} };
        signal.addEventListener('abort', cancel, {once:true});
        try {
          const url = ORIGIN + PATH;
          response = await fetchImpl(url, {method:'POST', redirect:'error', cache:'no-store', signal,
            headers:{'X-SubRouter-Saas-Activation-Token':token, 'Content-Type':'application/json', Accept:'application/json'},
            body:JSON.stringify({user_id:fact.userId, package_id:fact.packageId, code:fact.code, order_id:fact.orderId})});
          if (signal.aborted || !(response instanceof Response) || !response.ok || response.redirected
              || (response.url && response.url !== url) || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Error();
          const size = response.headers.get('content-length');
          if (size !== null && (!/^\d+$/.test(size) || Number(size) > 8192)) throw Error();
          reader = response.body?.getReader(); if (!reader) throw Error();
          let total = 0; const chunks = [];
          for (;;) {
            const {done,value} = await reader.read(); if (signal.aborted) throw Error(); if (done) break;
            if (!(value instanceof Uint8Array) || (total += value.length) > 8192 || chunks.length >= 1024) throw Error();
            chunks.push(value);
          }
          const envelope = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks,total)));
          const data = envelope?.data;
          if (envelope?.success !== true || !data || data.user_id !== fact.userId || data.package_id !== fact.packageId
              || data.order_id !== fact.orderId || data.quota_redeemed !== fact.expectedQuota || typeof data.already_activated !== 'boolean') throw Error();
          return Object.freeze({orderId:fact.orderId, userId:fact.userId, packageId:fact.packageId,
            quotaRedeemed:data.quota_redeemed, alreadyActivated:data.already_activated});
        } finally { signal.removeEventListener('abort',cancel); cancel(); try { reader?.releaseLock(); } catch {} }
      }, timeoutMs);
    } catch { throw fail('subrouter_activation_unverified'); }
  };
}

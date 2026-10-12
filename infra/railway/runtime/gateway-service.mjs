import { GatewayError, cloneJsonObject, exactInteger, strictObject, withDeadline } from './supabase-gateway-rpc.mjs';
import { createHash } from 'node:crypto';

// Match the existing gateway's SHA-256 of its exact JSON request envelope.
// Selectors must hash this same body/format envelope, not a model name or prompt
// alone. Different insertion order is a different byte fingerprint, as before.
export function gatewayPayloadFingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(cloneJsonObject(payload, 65536))).digest('hex');
}

// Private orchestration only. Caller-supplied pricing/financial projections are not accepted
// by an HTTP route here. A separately reviewed ingress must select trusted quotes and gates.
// Integration contract: reservation (including the payload fingerprint, key/budget IDs,
// model/rate and both currency quotes) comes from a trusted server selector. It must
// fingerprint the exact inert payload snapshot, enforced before any hold; this module does not authenticate API
// keys or discover prices, supplier credentials, financial projections or HTTP callers.
export function createGatewayService(config) {
  strictObject(config, ['rpc', 'dispatch', 'verifySettlement', 'dispatchTimeoutMs', 'settlementTimeoutMs', 'observeFailure']);
  const { rpc, dispatch, verifySettlement } = config;
  if (!rpc || ['reserve', 'claim', 'finish', 'uncertain', 'assertReference', 'assertDispatchWindow', 'assertPrivatePayload'].some(name => typeof rpc[name] !== 'function')
      || typeof dispatch !== 'function' || typeof verifySettlement !== 'function') throw new GatewayError('gateway_service_unconfigured');
  const dispatchTimeout = exactInteger(config.dispatchTimeoutMs ?? 25000, 1, 30000);
  const settlementTimeout = exactInteger(config.settlementTimeoutMs ?? 5000, 1, 10000);
  const held = id => Object.freeze({ ok: false, status: 'awaiting-reconciliation', ...(id ? { id } : {}), needsReconciliation: true, automaticRetry: false });
  const terminal = (record, replayed) => {
    if (record.state !== 'succeeded' || record.result_json === null || record.settlement_reference === null) return Object.freeze({ ok: false, id: record.id, status: 'failed', automaticRetry: false });
    const result = cloneJsonObject(record.result_json, 1048576); rpc.assertPrivatePayload(result);
    return Object.freeze({ ok: true, id: record.id, replayed, result });
  };
  return Object.freeze({
    async execute(context, reservation, payload) {
      // Snapshot inert request data before reserving; no late getter/payload mutation.
      const input = cloneJsonObject(payload, 65536); rpc.assertPrivatePayload(input);
      const quote = cloneJsonObject(reservation, 4096);
      if (quote.payloadHash !== gatewayPayloadFingerprint(input)) {
        throw new GatewayError('gateway_payload_fingerprint_mismatch', 409);
      }
      let claimed, stage = 'reserve';
      try {
        const reserved = await rpc.reserve(context, quote);
        rpc.assertReference(context, reserved.record);
        if (!reserved.fresh) {
          if (['succeeded', 'failed'].includes(reserved.record.state)) return terminal(reserved.record, true);
          return held(reserved.record.id); // Never redispatch existing reserved/executing/uncertain work.
        }
        stage = 'claim';
        const claim = await rpc.claim(context, reserved.record);
        // Once a validated claim response says executing, retain its handle for
        // best-effort cleanup even if authority expires before the next check.
        if (claim.claimed === true) claimed = claim.record;
        rpc.assertReference(context, claim.record);
        if (claim.claimed !== true) return held(claim.record.id);
        rpc.assertDispatchWindow(context, dispatchTimeout + settlementTimeout);
        // Exactly one invocation. An AbortSignal is a bound, not proof of supplier cancellation.
        stage = 'dispatch';
        const value = await withDeadline(signal => dispatch({ record: claimed, payload: input, signal }), dispatchTimeout);
        const providerResult = cloneJsonObject(value, 1048576); rpc.assertPrivatePayload(providerResult);
        // This trusted callback must independently reconcile real native-CNY liability.
        // A result/receipt string/verified=true supplied by a seller or client is not proof.
        stage = 'verify-settlement';
        const receipt = await withDeadline(signal => verifySettlement({ record: claimed, providerResult, signal }), settlementTimeout);
        stage = 'finish';
        const finished = await rpc.finish(context, claimed, receipt);
        rpc.assertReference(context, finished.record);
        if (finished.settled !== true) return held(finished.record.id); // Never expose result on overrun/freeze.
        return terminal(finished.record, false);
      } catch (error) {
        // Fixed internal categories only: never log upstream messages, prompts or credentials.
        const allowed = new Set(['subrouter_dispatch_not_confirmed','subrouter_response_identity_unconfirmed','subrouter_request_identity_unconfirmed','subrouter_invalid_usage','subrouter_invalid_response','subrouter_dispatch_requires_reconciliation','chat_request_invalid','retail_response_unverified','supplier_quote_bound_exceeded','gateway_invalid_response','gateway_rpc_unconfirmed','gateway_customer_limit','gateway_key_limit']);
        try { config.observeFailure?.({stage, code: allowed.has(error?.code) ? error.code : 'unclassified', ...(claimed ? {requestId: claimed.id} : {})}); } catch {}
        if (!claimed) {
          if (error instanceof GatewayError && !error.ambiguous) throw error;
          return held(); // Reserve/claim may have committed even if its response was lost.
        }
        try { await rpc.uncertain(context, claimed); } catch { /* No replay/release: executing may remain held or settlement may have committed. */ }
        // Genuine deadline overruns/expired authority require a freshly verified
        // owner reconciliation lane; this method never refreshes or replays them.
        return held(claimed.id); // No raw error, provider content, receipt or credentials are returned.
      }
    },
  });
}

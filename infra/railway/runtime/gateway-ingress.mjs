// Explicit server assembly only; mounted through the branded gateway HTTP adapter.
import { GatewayError, cloneJsonObject, strictObject, exactInteger, withDeadline } from './supabase-gateway-rpc.mjs';
import { isCustomerKeyRpc } from './customer-key-rpc.mjs';
import { gatewayPayloadFingerprint } from './gateway-service.mjs';
import { normalizeChatRequest, settledChatCompletion, bufferedChatStream } from './chat-compatibility.mjs';
const instances=new WeakSet();
export const isGatewayIngress=value=>instances.has(value);
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const bad = (status = 400) => { throw new GatewayError('gateway_request_rejected', status); };
async function body(request, signal) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('content-type') || '') || request.headers.has('content-encoding')) bad(415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) > 65536)) bad(413);
  const reader = request.body?.getReader(); if (!reader) bad();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0; const chunks = [];
  try {
    for (;;) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 65536) bad(413); chunks.push(next.value); }
    signal.throwIfAborted();
    if (!size || (length !== null && Number(length) !== size)) bad();
    return cloneJsonObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), 65536);
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
}
export function createGatewayIngress(config) {
  strictObject(config, ['rpc', 'keys', 'service', 'selectQuote', 'origin', 'enabled', 'maxConcurrent', 'playgroundModels']);
  if (config.origin !== 'https://apiwild.com' || typeof config.rpc?.verifyOwner !== 'function' || typeof config.rpc?.verifyKeyOwner !== 'function' || !isCustomerKeyRpc(config.keys) || typeof config.service?.execute !== 'function' || typeof config.selectQuote !== 'function') throw new GatewayError('gateway_ingress_unconfigured');
  const playgroundModels=(config.playgroundModels??[]).map(row=>{strictObject(row,['model','capability','maxOutputTokens','supportsTools']);if(typeof row.model!=='string'||!['chat','code','research'].includes(row.capability)||(row.supportsTools!==undefined&&typeof row.supportsTools!=='boolean'))throw new GatewayError('gateway_ingress_unconfigured');exactInteger(row.maxOutputTokens,1,32768);return Object.freeze({...row,supportsTools:row.supportsTools===true});});
  const rpc = config.rpc, keys = config.keys, service = config.service, selector = config.selectQuote;
  const origin = config.origin, enabled = config.enabled === true, limit = exactInteger(config.maxConcurrent ?? 4, 1, 16); let active = 0;
  const ingress=Object.freeze({ async handle(request) {
    if (!(request instanceof Request)) return reply(400, { error: 'Invalid request.' });
    if (!enabled || active >= limit) return reply(503, { error: 'Gateway unavailable.' });
    active++;
    try {
      const url = new URL(request.url);
      if (request.signal.aborted || url.origin !== origin || url.search || url.hash || (request.headers.has('origin') && request.headers.get('origin') !== origin)) bad(403);
      if ([...request.headers.keys()].some(k => k.startsWith('oai-authenticated-'))) bad(403);
      if (url.pathname === '/api/gateway/config') {
        if (request.method !== 'GET') bad(405);
        return reply(200, { inferenceEnabled: playgroundModels.length > 0, streaming: true, streamingMode: 'buffered-after-settlement', functionCalling: true, nativeStreaming: false, externalTools: false,
          modes: Object.fromEntries(['chat','code','research'].map(mode => [mode, playgroundModels.some(row => row.capability === mode)])),
          models: playgroundModels });
      }
      const authorization = request.headers.get('authorization') || '';
      const keyAuth = /^Bearer aw_(?:live|test)_[a-f0-9]{64}$/.test(authorization);
      const sessionAuth = authorization.length <= 8192 && /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization);
      // Reject missing/malformed credentials before parsing customer bodies.
      // This is syntax validation only; the verifiers below still establish identity.
      const keyRoute = ['/v1/chat/completions','/v1/models','/v1/usage'].includes(url.pathname);
      if (keyRoute ? !keyAuth
          : !(sessionAuth || (url.pathname === '/api/gateway' && request.method === 'POST' && keyAuth))) bad(401);
      if(url.pathname==='/api/gateway'&&request.method==='GET'){await rpc.verifyOwner({authorization});return reply(200,{inferenceConfigured:playgroundModels.length>0,streaming:false,externalTools:false,models:playgroundModels});}
      if (['/v1/models','/v1/usage'].includes(url.pathname)) {
        if (request.method !== 'GET') bad(405);
        // Read endpoints use the same chat key permission as this version of the
        // public completion API. Identity always comes from the verified key.
        const context = await rpc.verifyKeyOwner({ authorization, capability: 'chat' });
        if (url.pathname === '/v1/models') return reply(200, { object: 'list', data: [...new Set(playgroundModels.filter(row => row.capability === 'chat').map(row => row.model))].map(id => ({ id, object: 'model', owned_by: 'apiwild' })) });
        return reply(200, await rpc.usage(context));
      }
      if (url.pathname === '/api/account') {
        if (request.method !== 'GET') bad(405);
        const context = await rpc.verifyOwner({ authorization });
        await rpc.initializeAccount(context);
        return reply(200, { customerId: context.customerId, billingMode: context.billingMode, usage: await rpc.usage(context) });
      }
      if(url.pathname==='/api/usage'){if(request.method!=='GET')bad(405);const context=await rpc.verifyOwner({authorization});await rpc.initializeAccount(context);return reply(200,await rpc.usage(context));}
      if (['/api/keys','/api/gateway/keys'].includes(url.pathname)) {
        if (request.method === 'GET') return reply(200, { keys: await keys.list({ authorization }) });
        if (request.method !== 'POST') bad(405);
        const raw = await withDeadline(signal => body(request, signal), 5000);
        strictObject(raw, ['scopes', 'dailyLimitUsdMicros', 'totalLimitUsdMicros', 'expiresAt']);
        return reply(201, await keys.issue({ authorization, ...raw }));
      }
      const revoke = url.pathname.match(/^\/api\/(?:gateway\/)?keys\/([0-9a-f-]{36})$/);
      if (revoke) { if (request.method !== 'DELETE') bad(405); return reply(200, { key: await keys.revoke({ authorization, keyId: revoke[1] }) }); }
      const native = url.pathname === '/api/gateway';
      if (!native && url.pathname !== '/v1/chat/completions') bad(404);
      if (request.method !== 'POST') bad(405);
      const input = normalizeChatRequest(await withDeadline(signal => body(request, signal), 5000), {native});
      const requestKey = request.headers.get('idempotency-key') || '';
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey)) bad();
      if (!native && !keyAuth) bad(401);
      const context = keyAuth ? await rpc.verifyKeyOwner({ authorization, capability: input.capability }) : await rpc.verifyOwner({ authorization });
      if(!keyAuth&&typeof rpc.initializeAccount==='function')await rpc.initializeAccount(context);
      // Delivery options are part of the immutable reservation fingerprint. The
      // supplier still receives stream:false; no unverified output is exposed.
      const payload = { body: input.body, format: native ? 'native' : 'openai',
        ...(input.stream ? {delivery: {stream: true, includeUsage: input.includeUsage}} : {}) };
      const payloadHash = gatewayPayloadFingerprint(payload);
      const selected = await withDeadline(() => selector({ context, requestKey, payloadHash, capability: input.capability, model: input.body.model, maxTokens: input.body.max_tokens, payload: cloneJsonObject(payload, 65536) }), 5000);
      strictObject(selected, ['providerBudgetId', 'model', 'rateVersion', 'reservedUsdMicros', 'reservedCnyMicros']);
      if (selected.model !== input.body.model) bad(503);
      const reservation = { ...selected, keyId: keyAuth ? context.keyId : null, requestKey, payloadHash, capability: input.capability };
      if (request.signal.aborted) bad(409); // No first supplier spend after a known disconnect.
      const value = await service.execute(context, reservation, payload);
      if (!value.ok) return reply(503, { status: 'awaiting-reconciliation', automaticRetry: false });
      if (native) return reply(200, value);
      const completion = settledChatCompletion(value);
      if (input.stream) return new Response(bufferedChatStream(completion, {includeUsage: input.includeUsage, signal: request.signal}),
        {status: 200, headers: {...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no'}});
      return reply(200, completion);
    } catch (error) {
      return reply(error instanceof GatewayError && [400,401,402,403,404,405,409,413,415,422].includes(error.status) ? error.status : 503, { error: error?.code==='gateway_customer_limit'?'Your available credits or daily spending limit cannot cover this request.':error?.code==='gateway_key_limit'?'This API key has reached its spending limit.':error?.code==='gateway_inference_disabled'?'Model requests are not activated yet.':error?.code==='gateway_route_unavailable'?'This model is not available for the selected mode.':'Request could not be verified.', code:['gateway_customer_limit','gateway_key_limit','gateway_inference_disabled','gateway_route_unavailable'].includes(error?.code)?error.code:'gateway_request_failed', automaticRetry: false });
    } finally { active--; }
  } });
  instances.add(ingress);return ingress;
}

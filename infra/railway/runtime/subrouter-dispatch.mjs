// SERVER ONLY. Transport, not supplier acceptance or settlement verification.
// The trusted assembler supplies an already accepted, provider-scoped relay key.
// Never expose this configuration through a customer API or client bundle.
import { GatewayError, cloneJsonObject, exactInteger, strictObject } from './supabase-gateway-rpc.mjs';
import { normalizeChatRequest, chatInputBytes, validateAssistantMessage } from './chat-compatibility.mjs';
import {isSupplierRequestIdentity} from './supplier-request-identity.mjs';

export const SUBROUTER_CHAT_ENDPOINT = 'https://subrouter.ai/v1/chat/completions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code, ambiguous = false) => { throw new GatewayError(code, 503, ambiguous); };
function label(value, max = 160) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) fail('subrouter_invalid_configuration');
  return value;
}
async function boundedJson(response, signal) {
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) fail('subrouter_invalid_response', true);
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1048576)) fail('subrouter_response_too_large', true);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1048576) fail('subrouter_response_too_large', true);
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

// Empty routes are allowed and fail closed. Creation does not call an endpoint,
// create a key, accept a price or mount a production request route.
export function createSubrouterDispatch(config) {
  strictObject(config, ['routes', 'fetchImpl']);
  if (!Array.isArray(config.routes) || config.routes.length > 1000) fail('subrouter_invalid_configuration');
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('subrouter_invalid_configuration');
  const routes = new Map(); const secrets = [];
  for (const raw of config.routes) {
    strictObject(raw, ['providerBudgetId', 'model', 'upstreamModel', 'rateVersion', 'apiKey', 'capability', 'maxOutputTokens', 'maxInputChars', 'supportsTools', 'supplierSlug']);
    const r = { ...raw };
    label(r.providerBudgetId, 36); if (!UUID.test(r.providerBudgetId)) fail('subrouter_invalid_configuration');
    label(r.model); label(r.upstreamModel); label(r.rateVersion);
    if(r.supplierSlug!==undefined&&(typeof r.supplierSlug!=='string'||!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(r.supplierSlug)))fail('subrouter_invalid_configuration');
    if (!['chat', 'code', 'research'].includes(r.capability)) fail('subrouter_unsupported_capability');
    if (typeof r.apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{16,256}$/.test(r.apiKey)) fail('subrouter_invalid_configuration');
    exactInteger(r.maxOutputTokens, 1, 32768); exactInteger(r.maxInputChars, 1, 60000);
    if (r.supportsTools !== undefined && typeof r.supportsTools !== 'boolean') fail('subrouter_invalid_configuration');
    const identity = JSON.stringify([r.providerBudgetId, r.model, r.rateVersion, r.capability]);
    if (routes.has(identity)) fail('subrouter_duplicate_route');
    routes.set(identity, Object.freeze(r)); secrets.push(r.apiKey);
  }
  return async function dispatch({ record, payload, signal }) {
    const route = routes.get(JSON.stringify([record?.provider_budget_id, record?.model, record?.rate_version, record?.capability]));
    if (!route || record?.state !== 'executing') fail('subrouter_route_unavailable');
    if (!(signal instanceof AbortSignal) || signal.aborted) fail('subrouter_invalid_dispatch_signal');
    const envelope = cloneJsonObject(payload, 65536);
    strictObject(envelope, ['body', 'format', 'delivery']);
    if (!['native', 'openai'].includes(envelope.format)) fail('subrouter_unsupported_format');
    if (envelope.delivery !== undefined) {
      strictObject(envelope.delivery, ['stream', 'includeUsage']);
      if (envelope.format !== 'openai' || envelope.delivery.stream !== true || typeof envelope.delivery.includeUsage !== 'boolean') fail('subrouter_unsupported_format');
    }
    if (envelope.body?.model !== route.model) fail('subrouter_request_model_mismatch');
    if (envelope.body?.stream !== undefined && envelope.body.stream !== false) fail('subrouter_streaming_not_enabled');
    const normalized = normalizeChatRequest(envelope.body, {native: envelope.format === 'native'}), body = normalized.body;
    if (normalized.usesTools && route.supportsTools !== true) fail('subrouter_tools_not_enabled');
    const maxTokens = exactInteger(body.max_tokens, 1, route.maxOutputTokens);
    const request = {...body, model: route.upstreamModel, stream: false};
    // Despite the legacy field name, this is a conservative UTF-8 byte bound
    // over the whole dispatched JSON, including tool schemas and call history.
    if (chatInputBytes(request) > route.maxInputChars) fail('subrouter_invalid_messages');
    if (secrets.some(secret => JSON.stringify(request).includes(secret))) fail('subrouter_private_payload_rejected');
    try {
      // One request, fixed host, redirects forbidden. No automatic fallback or retry.
      const response = await fetchImpl(SUBROUTER_CHAT_ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer ' + route.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(request), redirect: 'error', cache: 'no-store', signal });
      if (!response.ok || response.redirected) fail('subrouter_dispatch_not_confirmed', true);
      const value = await boundedJson(response, signal);
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.id) || value.model !== route.upstreamModel) fail('subrouter_response_identity_unconfirmed', true);
      // The wallet log identifies this exact HTTP response by x-request-id.
      // Preserve completion identity separately; neither ID is customer output.
      const providerRequestId = response.headers.get('x-request-id');
      if (providerRequestId !== null && !isSupplierRequestIdentity(providerRequestId,{supplierSlug:route.supplierSlug,model:route.model})) fail('subrouter_request_identity_unconfirmed', true);
      const input = exactInteger(value.usage?.prompt_tokens); const output = exactInteger(value.usage?.completion_tokens, 0, maxTokens);
      const total = exactInteger(input + output);
      if (value.usage.total_tokens !== undefined && value.usage.total_tokens !== total) fail('subrouter_invalid_usage', true);
      if (!Array.isArray(value.choices) || value.choices.length !== 1 || (value.choices[0]?.index !== undefined && value.choices[0].index !== 0)) fail('subrouter_invalid_response', true);
      const assistant = validateAssistantMessage(value.choices[0].message, body);
      const finish = value.choices[0].finish_reason;
      if ((assistant.toolCalls && finish !== 'tool_calls') || (!assistant.toolCalls && finish === 'tool_calls')) fail('subrouter_incomplete_tool_result', true);
      const result = { providerResponseId: value.id, ...(providerRequestId ? {providerRequestId} : {}), model: value.model, ...assistant,
        created: exactInteger(value.created ?? Math.floor(Date.now() / 1000)),
        finishReason: ['stop', 'length', 'content_filter', 'tool_calls'].includes(finish) ? finish : null,
        usage: { prompt_tokens: input, completion_tokens: output }, settlementVerified: false };
      if (secrets.some(secret => JSON.stringify(result).includes(secret))) fail('subrouter_private_response_rejected', true);
      return Object.freeze(result);
    } catch { fail('subrouter_dispatch_requires_reconciliation', true); }
  };
}

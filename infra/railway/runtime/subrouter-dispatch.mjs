// SERVER ONLY. Transport, not supplier acceptance or settlement verification.
// The trusted assembler supplies an already accepted, provider-scoped relay key.
// Never expose this configuration through a customer API or client bundle.
import { GatewayError, cloneJsonObject, exactInteger, strictObject } from './supabase-gateway-rpc.mjs';

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
    strictObject(raw, ['providerBudgetId', 'model', 'upstreamModel', 'rateVersion', 'apiKey', 'capability', 'maxOutputTokens', 'maxInputChars']);
    const r = { ...raw };
    label(r.providerBudgetId, 36); if (!UUID.test(r.providerBudgetId)) fail('subrouter_invalid_configuration');
    label(r.model); label(r.upstreamModel); label(r.rateVersion);
    if (!['chat', 'code', 'research'].includes(r.capability)) fail('subrouter_unsupported_capability');
    if (typeof r.apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{16,256}$/.test(r.apiKey)) fail('subrouter_invalid_configuration');
    exactInteger(r.maxOutputTokens, 1, 32768); exactInteger(r.maxInputChars, 1, 60000);
    const identity = JSON.stringify([r.providerBudgetId, r.model, r.rateVersion, r.capability]);
    if (routes.has(identity)) fail('subrouter_duplicate_route');
    routes.set(identity, Object.freeze(r)); secrets.push(r.apiKey);
  }
  return async function dispatch({ record, payload, signal }) {
    const route = routes.get(JSON.stringify([record?.provider_budget_id, record?.model, record?.rate_version, record?.capability]));
    if (!route || record?.state !== 'executing') fail('subrouter_route_unavailable');
    if (!(signal instanceof AbortSignal) || signal.aborted) fail('subrouter_invalid_dispatch_signal');
    const envelope = cloneJsonObject(payload, 65536);
    strictObject(envelope, ['body', 'format']);
    if (!['native', 'openai'].includes(envelope.format)) fail('subrouter_unsupported_format');
    const body = strictObject(envelope.body, ['model', 'messages', 'max_tokens', 'stream', 'temperature']);
    if (body.model !== undefined && body.model !== route.model && body.model !== route.upstreamModel) fail('subrouter_request_model_mismatch');
    if (body.stream !== undefined && body.stream !== false) fail('subrouter_streaming_not_enabled');
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 30) fail('subrouter_invalid_messages');
    let chars = 0;
    for (const message of body.messages) {
      strictObject(message, ['role', 'content']);
      if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.length) fail('subrouter_invalid_messages');
      chars += message.content.length;
    }
    if (chars > route.maxInputChars || !body.messages.some(m => m.role === 'user')) fail('subrouter_invalid_messages');
    const maxTokens = exactInteger(body.max_tokens, 1, route.maxOutputTokens);
    if (body.temperature !== undefined && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) fail('subrouter_invalid_temperature');
    const request = { model: route.upstreamModel, messages: body.messages, max_tokens: maxTokens, stream: false, ...(body.temperature !== undefined ? { temperature: body.temperature } : {}) };
    if (secrets.some(secret => JSON.stringify(request).includes(secret))) fail('subrouter_private_payload_rejected');
    try {
      // One request, fixed host, redirects forbidden. No automatic fallback or retry.
      const response = await fetchImpl(SUBROUTER_CHAT_ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer ' + route.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(request), redirect: 'error', cache: 'no-store', signal });
      if (!response.ok || response.redirected) fail('subrouter_dispatch_not_confirmed', true);
      const value = await boundedJson(response, signal);
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.length || value.id.length > 160 || value.model !== route.upstreamModel) fail('subrouter_response_identity_unconfirmed', true);
      const input = exactInteger(value.usage?.prompt_tokens); const output = exactInteger(value.usage?.completion_tokens, 0, maxTokens);
      if (!Array.isArray(value.choices) || value.choices.length !== 1 || value.choices[0]?.message?.role !== 'assistant' || typeof value.choices[0].message.content !== 'string' || !value.choices[0].message.content.length || value.choices[0].message.tool_calls?.length) fail('subrouter_invalid_response', true);
      const finish = value.choices[0].finish_reason;
      const result = { providerResponseId: value.id, model: value.model, text: value.choices[0].message.content, finishReason: ['stop', 'length', 'content_filter'].includes(finish) ? finish : null, usage: { prompt_tokens: input, completion_tokens: output }, settlementVerified: false };
      if (secrets.some(secret => JSON.stringify(result).includes(secret))) fail('subrouter_private_response_rejected', true);
      return Object.freeze(result);
    } catch { fail('subrouter_dispatch_requires_reconciliation', true); }
  };
}

// Bounded Chat Completions compatibility. Tool definitions/results are inert
// JSON data: this module never evaluates a schema, fetches a reference or calls a function.
import {GatewayError, cloneJsonObject, strictObject, exactInteger} from './supabase-gateway-rpc.mjs';
const fail = (status = 400) => { throw new GatewayError('gateway_request_rejected', status); };
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const callPattern = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, max, pattern, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max || (pattern && !pattern.test(value))) fail();
  return value;
}
function schema(value, depth = 0, budget = {nodes: 0}) {
  if (!object(value) || depth > 10 || ++budget.nodes > 512) fail(413);
  strictObject(value, ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
    'anyOf', 'oneOf', 'allOf', '$defs', '$ref', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'title', 'default']);
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || types.length > 7 || new Set(types).size !== types.length || types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) fail();
  }
  for (const key of ['description', 'title']) if (value[key] !== undefined) string(value[key], 2048, undefined, true);
  if (value.$ref !== undefined) string(value.$ref, 256, /^#\/[A-Za-z0-9_~./-]+$/); // No external reference resolution.
  for (const key of ['properties', '$defs']) if (value[key] !== undefined) {
    if (!object(value[key]) || Object.keys(value[key]).length > 100) fail(413);
    for (const [name, child] of Object.entries(value[key])) { string(name, 128, /^[^\x00-\x1f\x7f]+$/); schema(child, depth + 1, budget); }
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.length > 100
    || new Set(value.required).size !== value.required.length || value.required.some(name => typeof name !== 'string' || !Object.hasOwn(value.properties || {}, name)))) fail();
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') schema(value.additionalProperties, depth + 1, budget);
  if (value.items !== undefined) schema(value.items, depth + 1, budget);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 10) fail();
    value[key].forEach(child => schema(child, depth + 1, budget));
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 100)) fail();
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) fail();
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (value[key] !== undefined) exactInteger(value[key], 0, 1000000);
  if (value.pattern !== undefined) string(value.pattern, 512, undefined, true); // Forwarded, never compiled here.
  if (value.format !== undefined) string(value.format, 64, /^[A-Za-z0-9_-]+$/);
}
export function validateToolCalls(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16) fail();
  const ids = new Set();
  for (const call of value) {
    strictObject(call, ['id', 'type', 'function']);
    string(call.id, 128, callPattern); if (ids.has(call.id) || call.type !== 'function') fail(); ids.add(call.id);
    strictObject(call.function, ['name', 'arguments']); string(call.function.name, 64, namePattern);
    string(call.function.arguments, 16384);
    if (Buffer.byteLength(call.function.arguments) > 16384) fail(413);
    let args; try { args = JSON.parse(call.function.arguments); } catch { fail(); }
    cloneJsonObject(args, 16384); // Function arguments must be a bounded JSON object.
  }
  return value;
}
export function usesFunctionTools(body) {
  return ['tools', 'tool_choice', 'parallel_tool_calls'].some(key => body[key] !== undefined)
    || body.messages.some(message => message.role === 'tool' || message.tool_calls !== undefined);
}
export function normalizeChatRequest(input, {native = false} = {}) {
  const raw = cloneJsonObject(input, 65536);
  const fields = ['model', 'messages', 'max_tokens', 'temperature', 'stream'];
  strictObject(raw, native ? ['mode', ...fields] : [...fields, 'max_completion_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options', 'n']);
  const capability = native ? raw.mode ?? 'chat' : 'chat';
  if (!['chat', 'code', 'research'].includes(capability)) fail();
  string(raw.model, 160, /^[^\x00-\x20\x7f]+$/);
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') fail(422);
  if (native && raw.stream === true) fail(422);
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined) fail();
  const maxTokens = exactInteger(raw.max_tokens ?? raw.max_completion_tokens ?? 1024, 1, 32768);
  if (raw.temperature !== undefined && (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2)) fail();
  if (raw.n !== undefined && raw.n !== 1) fail(422);
  let includeUsage = false;
  if (raw.stream_options !== undefined) {
    strictObject(raw.stream_options, ['include_usage']);
    if (raw.stream !== true || typeof raw.stream_options.include_usage !== 'boolean') fail();
    includeUsage = raw.stream_options.include_usage;
  }
  if (!Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > 30) fail();
  let chars = 0; const pending = new Set(), seenCalls = new Set();
  for (const message of raw.messages) {
    strictObject(message, native ? ['role', 'content'] : ['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
    const roles = native ? ['system', 'user', 'assistant'] : ['system', 'developer', 'user', 'assistant', 'tool'];
    if (!roles.includes(message.role)) fail();
    if (message.name !== undefined) string(message.name, 64, namePattern);
    if (message.role === 'tool') {
      if (message.tool_calls !== undefined || message.name !== undefined || !pending.has(message.tool_call_id)) fail();
      string(message.content, 60000, undefined, true); pending.delete(message.tool_call_id);
    } else {
      if (pending.size || message.tool_call_id !== undefined) fail();
      if (message.tool_calls !== undefined) {
        if (message.role !== 'assistant' || native) fail();
        for (const call of validateToolCalls(message.tool_calls)) {
          if (seenCalls.has(call.id)) fail(); seenCalls.add(call.id); pending.add(call.id);
        }
        if (message.content !== undefined && message.content !== null) string(message.content, 60000, undefined, true);
      } else string(message.content, 60000);
    }
    chars += typeof message.content === 'string' ? message.content.length : 0;
  }
  if (pending.size || chars > 60000 || !raw.messages.some(message => message.role === 'user')) fail(413);
  const names = new Set();
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || !raw.tools.length || raw.tools.length > 32 || Buffer.byteLength(JSON.stringify(raw.tools)) > 32768) fail(413);
    for (const tool of raw.tools) {
      strictObject(tool, ['type', 'function']); if (tool.type !== 'function') fail(422);
      strictObject(tool.function, ['name', 'description', 'parameters', 'strict']);
      string(tool.function.name, 64, namePattern); if (names.has(tool.function.name)) fail(); names.add(tool.function.name);
      if (tool.function.description !== undefined) string(tool.function.description, 2048, undefined, true);
      if (tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean') fail();
      if (tool.function.parameters !== undefined) { if (!object(tool.function.parameters) || tool.function.parameters.type !== 'object') fail(); schema(tool.function.parameters); }
    }
  }
  if (raw.tool_choice !== undefined) {
    if (typeof raw.tool_choice === 'string') { if (!['auto', 'none', 'required'].includes(raw.tool_choice) || (raw.tool_choice !== 'none' && !names.size)) fail(); }
    else { strictObject(raw.tool_choice, ['type', 'function']); strictObject(raw.tool_choice.function, ['name']);
      if (raw.tool_choice.type !== 'function' || !names.has(raw.tool_choice.function.name)) fail(); }
  }
  if (raw.parallel_tool_calls !== undefined && (typeof raw.parallel_tool_calls !== 'boolean' || !names.size)) fail();
  const body = {model: raw.model, messages: raw.messages, max_tokens: maxTokens, stream: false,
    ...(raw.temperature !== undefined ? {temperature: raw.temperature} : {}),
    ...(raw.n !== undefined ? {n: raw.n} : {}), ...(raw.tools !== undefined ? {tools: raw.tools} : {}),
    ...(raw.tool_choice !== undefined ? {tool_choice: raw.tool_choice} : {}),
    ...(raw.parallel_tool_calls !== undefined ? {parallel_tool_calls: raw.parallel_tool_calls} : {})};
  return {capability, body, stream: raw.stream === true, includeUsage, usesTools: usesFunctionTools(body)};
}
export function chatInputBytes(body) { return Buffer.byteLength(JSON.stringify(body)); }
export function validateAssistantMessage(message, body) {
  if (!object(message) || message.role !== 'assistant') fail(503);
  const calls = message.tool_calls === undefined ? undefined : validateToolCalls(message.tool_calls);
  if (calls) {
    const names = new Set((body.tools ?? []).map(tool => tool.function.name));
    if (body.tool_choice === 'none' || !names.size || calls.some(call => !names.has(call.function.name))
      || (body.parallel_tool_calls === false && calls.length > 1)
      || (object(body.tool_choice) && calls.some(call => call.function.name !== body.tool_choice.function.name))) fail(503);
  } else if (body.tool_choice === 'required' || object(body.tool_choice)) fail(503);
  if (message.content !== null && message.content !== undefined) string(message.content, 900000, undefined, true);
  if (!calls && (typeof message.content !== 'string' || !message.content.length)) fail(503);
  return {text: message.content ?? null, ...(calls ? {toolCalls: calls} : {})};
}
export function settledChatCompletion(value) {
  const result = value?.result;
  if (value?.ok !== true || !result || typeof result.model !== 'string') fail(503);
  const prompt = exactInteger(result.usage?.prompt_tokens), completion = exactInteger(result.usage?.completion_tokens);
  const total = exactInteger(prompt + completion);
  const calls = result.toolCalls === undefined ? undefined : validateToolCalls(result.toolCalls);
  if (result.text !== null && result.text !== undefined) string(result.text, 900000, undefined, true);
  if (!calls && (typeof result.text !== 'string' || !result.text.length)) fail(503);
  const finish = ['stop', 'length', 'content_filter', 'tool_calls'].includes(result.finishReason) ? result.finishReason : null;
  if (calls && finish !== 'tool_calls') fail(503);
  return {id: string(value.id, 160, /^[^\x00-\x20\x7f]+$/), object: 'chat.completion',
    created: exactInteger(result.created ?? Math.floor(Date.now() / 1000)), model: result.model,
    choices: [{index: 0, message: {role: 'assistant', content: result.text ?? null, ...(calls ? {tool_calls: calls} : {})}, finish_reason: finish}],
    usage: {prompt_tokens: prompt, completion_tokens: completion, total_tokens: total}};
}
function* pieces(text) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 4096, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield text.slice(offset, end); offset = end;
  }
}
export function bufferedChatStream(completion, {includeUsage = false, signal} = {}) {
  const base = {id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model};
  const choice = completion.choices[0], encoder = new TextEncoder();
  function chunk(delta, finish_reason = null) { return {...base, choices: [{index: 0, delta, finish_reason}], ...(includeUsage ? {usage: null} : {})}; }
  function* events() {
    yield chunk({role: 'assistant', content: ''});
    if (typeof choice.message.content === 'string') for (const content of pieces(choice.message.content)) yield chunk({content});
    for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
      yield chunk({tool_calls: [{index, id: call.id, type: 'function', function: {name: call.function.name, arguments: ''}}]});
      for (const args of pieces(call.function.arguments)) yield chunk({tool_calls: [{index, function: {arguments: args}}]});
    }
    yield chunk({}, choice.finish_reason);
    if (includeUsage) yield {...base, choices: [], usage: completion.usage};
    yield '[DONE]';
  }
  const iterator = events(); let cancelled = false;
  return new ReadableStream({
    pull(controller) {
      if (cancelled || signal?.aborted) { cancelled = true; iterator.return(); controller.close(); return; }
      const next = iterator.next(); if (next.done) { controller.close(); return; }
      controller.enqueue(encoder.encode('data: ' + (typeof next.value === 'string' ? next.value : JSON.stringify(next.value)) + '\n\n'));
    },
    cancel() { cancelled = true; iterator.return(); },
  });
}

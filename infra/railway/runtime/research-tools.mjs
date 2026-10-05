// Explicit, read-only utilities. Retrieved material is untrusted source data,
// never an instruction to the server or an automatically executed model tool.
import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';
import {GatewayError, strictObject} from './supabase-gateway-rpc.mjs';

const HOST = 'en.wikipedia.org';
const MAX_BODY = 65536;
export const RESEARCH_TOOL_METADATA = Object.freeze({
  tools: Object.freeze(['search', 'read', 'calculate']),
  searchSource: 'English Wikipedia',
  allowedReadHosts: Object.freeze([HOST]),
  readMode: 'article-summary',
  externalActions: false,
  modelCalls: false,
});

export class ResearchToolError extends GatewayError {
  constructor(message, code = 'invalid_input') {
    const codes = {invalid_input: ['research_tools_invalid_input', 400],
      source_unavailable: ['research_tools_source_unavailable', 503], response_limit: ['research_tools_too_large', 413]};
    super(...(codes[code] || codes.source_unavailable));
  }
}
const invalid = message => {throw new ResearchToolError(message);};
const unavailable = () => new ResearchToolError('The research source is unavailable. Try again later.', 'source_unavailable');
const plain = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid('Invalid research tool input.');
  return value.trim();
};

function articleUrl(raw) {
  let url;
  try {url = new URL(plain(raw, 2048));} catch {invalid('Use an English Wikipedia article URL.');}
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith('/wiki/')) invalid('Use an English Wikipedia article URL without query parameters or fragments.');
  let title;
  try {title = decodeURIComponent(url.pathname.slice(6));} catch {invalid('Invalid article URL.');}
  if (!title || title.length > 300 || /[\x00-\x1f\x7f/:\\?#]/.test(title) || title === '.' || title === '..') invalid('Use a standard Wikipedia article URL.');
  return {url: `https://${HOST}/wiki/${encodeURIComponent(title)}`, title};
}

export function validateResearchToolInput(input) {
  try {strictObject(input, ['tool', 'query', 'url', 'expression']);} catch {invalid('Invalid research tool input.');}
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !['search', 'read', 'calculate'].includes(input.tool)) invalid('Choose search, read or calculate.');
  const field = {search: 'query', read: 'url', calculate: 'expression'}[input.tool];
  if (Object.keys(input).some(key => !['tool', field].includes(key))) invalid('Unknown research tool input field.');
  if (input.tool === 'search') return Object.freeze({tool: 'search', query: plain(input.query, 200)});
  if (input.tool === 'read') return Object.freeze({tool: 'read', url: articleUrl(input.url).url});
  const expression = plain(input.expression, 120);
  // Parse during validation; unsupported expressions never reach a transport.
  calculate(expression);
  return Object.freeze({tool: 'calculate', expression});
}

function calculate(expression) {
  if (/[\d.]\s+[\d.]/.test(expression)) invalid('Separate numbers with an arithmetic operator.');
  const source = expression.replace(/\s/g, '');
  if (!source || /[^0-9.+\-*/%()]/.test(source)) invalid('Use numbers, parentheses and + - * / % only.');
  let offset = 0, operations = 0, depth = 0;
  const bounded = value => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e12) invalid('Calculation exceeds the supported range.');
    return Object.is(value, -0) ? 0 : value;
  };
  const atom = () => {
    if (++depth > 16) invalid('Calculation is too deeply nested.');
    let value;
    if (source[offset] === '+' || source[offset] === '-') {
      const sign = source[offset++] === '-' ? -1 : 1;
      if (++operations > 32) invalid('Calculation has too many operations.');
      value = bounded(sign * atom());
    } else if (source[offset] === '(') {
      offset++; value = sum();
      if (source[offset++] !== ')') invalid('Unbalanced calculation parentheses.');
    } else {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(offset));
      if (!number) invalid('Invalid calculation expression.');
      offset += number[0].length; value = bounded(Number(number[0]));
    }
    depth--; return value;
  };
  const product = () => {
    let value = atom();
    while (['*', '/', '%'].includes(source[offset])) {
      const operation = source[offset++], right = atom();
      if (++operations > 32) invalid('Calculation has too many operations.');
      if (['/', '%'].includes(operation) && right === 0) invalid('Division by zero is not supported.');
      value = bounded(operation === '*' ? value * right : operation === '/' ? value / right : value % right);
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (['+', '-'].includes(source[offset])) {
      const operation = source[offset++], right = product();
      if (++operations > 32) invalid('Calculation has too many operations.');
      value = bounded(operation === '+' ? value + right : value - right);
    }
    return value;
  };
  const result = sum();
  if (offset !== source.length) invalid('Invalid calculation expression.');
  return result;
}

// Reject every non-global IPv4 range, not merely RFC1918. The transport pins
// the vetted address while retaining the original hostname for TLS validation.
function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function pinnedFetch(url, {signal, address}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal, agent: false, rejectUnauthorized: true, servername: HOST,
      headers: {accept: 'application/json', 'user-agent': 'APIWILD-Research/1.0 (https://apiwild.com)'},
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{address, family: 4}]) : callback(null, address, 4),
    }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve({status: response.statusCode, ok: response.statusCode === 200, url,
        headers, body: Readable.toWeb(response)});
    });
    request.on('error', reject);
  });
}

async function readJson(response, expectedUrl, signal) {
  if (!response || response.status !== 200 || !response.ok || response.url !== expectedUrl
      || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) {
    await response?.body?.cancel?.().catch(() => {}); throw unavailable();
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    await response.body?.cancel?.().catch(() => {}); throw new ResearchToolError('The research source response is too large.', 'response_limit');
  }
  if (!response.body?.getReader) throw unavailable();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new ResearchToolError('The research source response is too large.', 'response_limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

function sourceText(value, max) {
  if (typeof value !== 'string') throw unavailable();
  // Remove markup; React/JSON clients must still render these values as text.
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, match =>
    ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}[match]))
    .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

export function createResearchTools({fetchImpl = pinnedFetch, lookupImpl = dnsLookup, timeoutMs = 5000} = {}) {
  if (typeof fetchImpl !== 'function' || typeof lookupImpl !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw Error('Invalid research utility configuration.');
  async function execute(raw, {signal} = {}) {
    const input = validateResearchToolInput(raw);
    if (signal?.aborted) throw unavailable();
    if (input.tool === 'calculate') return {ok: true, tool: 'calculate', expression: input.expression, result: calculate(input.expression)};
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, timeoutMs);
    try {
      const addresses = await abortable(lookupImpl(HOST, {all: true, family: 4, verbatim: true}), controller.signal);
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 20
          || addresses.some(row => row.family !== 4 || !publicAddress(row.address))) throw unavailable();
      const title = input.tool === 'read' ? articleUrl(input.url).title : null;
      const target = input.tool === 'search'
        ? `https://${HOST}/w/api.php?${new URLSearchParams({action: 'query', format: 'json', formatversion: '2', list: 'search', srsearch: input.query, srlimit: '5', srprop: 'snippet', utf8: '1'})}`
        : `https://${HOST}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const response = await abortable(fetchImpl(target, {signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: {accept: 'application/json'}, address: addresses[0].address}), controller.signal);
      const data = await readJson(response, target, controller.signal);
      if (input.tool === 'search') {
        if (!Array.isArray(data?.query?.search) || data.query.search.length > 5) throw unavailable();
        const results = data.query.search.map(row => {
          const title = sourceText(row.title, 300);
          const article = articleUrl(`https://${HOST}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`);
          return {title, url: article.url, snippet: sourceText(row.snippet, 600)};
        });
        return {ok: true, tool: 'search', source: 'English Wikipedia', query: input.query, results,
          citations: results.map(({title, url}) => ({title, url}))};
      }
      if (data?.type !== 'standard' || typeof data?.extract !== 'string' || !data.extract.trim()) throw unavailable();
      const outputTitle = sourceText(data.title, 300), text = sourceText(data.extract, 6000);
      return {ok: true, tool: 'read', source: 'English Wikipedia article summary', title: outputTitle,
        url: input.url, text, truncated: data.extract.length > 6000, citations: [{title: outputTitle, url: input.url}]};
    } catch (error) {
      if (error instanceof ResearchToolError) throw error;
      throw unavailable();
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();}
  }
  return Object.freeze({execute});
}

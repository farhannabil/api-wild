// Explicit, read-only utilities. Retrieved material is untrusted source data,
// never an instruction to the server or an automatically executed model tool.
import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';
import {GatewayError, strictObject} from './supabase-gateway-rpc.mjs';

const HOST = 'en.wikipedia.org';
const SEARCH_HOST = 'html.duckduckgo.com';
const MAX_BODY = 65536;
const MAX_SEARCH_BODY = 262144;
export const RESEARCH_TOOL_METADATA = Object.freeze({
  tools: Object.freeze(['search', 'read', 'calculate']),
  searchSource: 'DuckDuckGo web search',
  searchSources: Object.freeze(['web', 'wikipedia']),
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
  try {strictObject(input, ['tool', 'query', 'source', 'url', 'expression']);} catch {invalid('Invalid research tool input.');}
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !['search', 'read', 'calculate'].includes(input.tool)) invalid('Choose search, read or calculate.');
  const field = {search: 'query', read: 'url', calculate: 'expression'}[input.tool];
  if (Object.keys(input).some(key => !['tool', field, ...(input.tool === 'search' ? ['source'] : [])].includes(key))) invalid('Unknown research tool input field.');
  if (input.tool === 'search') {
    if (input.source !== undefined && !['web', 'wikipedia'].includes(input.source)) invalid('Choose web or Wikipedia search.');
    return Object.freeze({tool: 'search', query: plain(input.query, 200), ...(input.source ? {source: input.source} : {})});
  }
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

function pinnedFetch(url, {signal, address, headers}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal, agent: false, rejectUnauthorized: true, servername: new URL(url).hostname,
      headers: {accept: headers.accept, 'user-agent': 'APIWILD-Research/1.0 (https://apiwild.com)'},
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

async function readBody(response, expectedUrl, signal, {html = false, diagnostic} = {}) {
  const maxBody = html ? MAX_SEARCH_BODY : MAX_BODY;
  if (diagnostic) {
    diagnostic.phase = 'response';
    diagnostic.reason = !response || typeof response.headers?.get !== 'function' ? 'response_shape'
      : response.status !== 200 || !response.ok ? 'response_status'
      : response.url !== expectedUrl ? 'response_identity' : 'content_type';
  }
  if (!response || response.status !== 200 || !response.ok || response.url !== expectedUrl
      || !(html ? /^text\/html(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(response.headers?.get('content-type') || '')) {
    await response?.body?.cancel?.().catch(() => {}); throw unavailable();
  }
  const length = response.headers.get('content-length');
  if (diagnostic) diagnostic.reason = 'body_limit';
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBody)) {
    await response.body?.cancel?.().catch(() => {}); throw new ResearchToolError('The research source response is too large.', 'response_limit');
  }
  if (diagnostic) {diagnostic.phase = 'body'; diagnostic.reason = 'body_missing';}
  if (!response.body?.getReader) throw unavailable();
  if (diagnostic) diagnostic.reason = 'body_failure';
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) {
        if (diagnostic) diagnostic.reason = 'body_limit';
        throw new ResearchToolError('The research source response is too large.', 'response_limit');
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (diagnostic) {diagnostic.phase = 'parse'; diagnostic.reason = 'invalid_payload';}
    return html ? body : JSON.parse(body);
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

function entities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#\d{1,7}|#x[0-9a-f]{1,6});/gi, match => {
    const named = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' '};
    if (named[match.toLowerCase()]) return named[match.toLowerCase()];
    const point = /^&#x/i.test(match) ? parseInt(match.slice(3, -1), 16) : Number(match.slice(2, -1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

function sourceText(value, max) {
  if (typeof value !== 'string') throw unavailable();
  // Remove markup; React/JSON clients must still render these values as text.
  return entities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<[^>]*>/g, ''))
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function attribute(tag, name) {
  const matches = [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].filter(match => match[1].toLowerCase() === name);
  return matches.length === 1 ? entities(matches[0][2] ?? matches[0][3]) : null;
}

function resultUrl(raw) {
  if (!raw || raw.length > 4096 || /[\x00-\x20\x7f\\]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, 'https://duckduckgo.com');
    // Extract the destination locally; never follow the search-engine redirect.
    if (['duckduckgo.com', SEARCH_HOST].includes(url.hostname) && url.pathname === '/l/') {
      const targets = url.searchParams.getAll('uddg');
      if (targets.length !== 1 || /[\x00-\x20\x7f\\]/.test(targets[0])) return null;
      url = new URL(targets[0]);
    } else if (!/^https?:\/\//i.test(raw)) return null;
  } catch {return null;}
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 2048
      || /[\x00-\x20\x7f\\]/.test(url.href) || isIP(url.hostname) || !url.hostname.includes('.')
      || url.hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|onion|invalid|test|example)$/.test(url.hostname)
      || !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return url.href;
}

function webResults(html, diagnostic) {
  // A challenge is an unavailable source, never a result or a retry target.
  if (/anomaly-modal|challenge-form|\/anomaly\.js|g-recaptcha|h-captcha/i.test(html)) {
    if (diagnostic) diagnostic.reason = 'challenge';
    throw unavailable();
  }
  const cards = [...html.matchAll(/<div\b[^>]*\bclass\s*=\s*(["'])([^"']*\bweb-result\b[^"']*)\1[^>]*>/gi)];
  const results = [], seen = new Set();
  for (let index = 0; index < cards.length && results.length < 5; index++) {
    if (/\bresult--ad\b/.test(cards[index][2])) continue;
    const card = html.slice(cards[index].index + cards[index][0].length, cards[index + 1]?.index ?? html.length);
    const links = [...card.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
    const link = links.find(match => attribute(match[1], 'class')?.split(/\s+/).includes('result__a'));
    if (!link) continue;
    const url = resultUrl(attribute(link[1], 'href'));
    const title = sourceText(link[2], 300);
    const snippetLink = links.find(match => attribute(match[1], 'class')?.split(/\s+/).includes('result__snippet'));
    const snippet = snippetLink ? sourceText(snippetLink[2], 600) : '';
    if (url && title && !seen.has(url)) {seen.add(url); results.push({title, url, snippet});}
  }
  if (!results.length && !/class\s*=\s*["'][^"']*\bno-results\b|No results found/i.test(html)) {
    if (diagnostic) diagnostic.reason = 'unknown_markup';
    throw unavailable();
  }
  return results;
}

export function createResearchTools({fetchImpl = pinnedFetch, lookupImpl = dnsLookup, timeoutMs = 5000, observeFailure = () => {}} = {}) {
  if (typeof fetchImpl !== 'function' || typeof lookupImpl !== 'function'
      || typeof observeFailure !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw Error('Invalid research utility configuration.');
  async function execute(raw, {signal} = {}) {
    const input = validateResearchToolInput(raw);
    if (signal?.aborted) throw unavailable();
    if (input.tool === 'calculate') return {ok: true, tool: 'calculate', expression: input.expression, result: calculate(input.expression)};
    // Fixed enums only: never send the query, target, source body or raw error to logs.
    const diagnostic = {researchToolFailure: true, source: input.tool === 'search' && input.source !== 'wikipedia' ? 'web' : 'wikipedia',
      phase: 'dns', reason: 'dns_failure', status: null, encoding: 'absent'};
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; abort();}, timeoutMs);
    try {
      const webSearch = input.tool === 'search' && input.source !== 'wikipedia';
      const host = webSearch ? SEARCH_HOST : HOST;
      const addresses = await abortable(lookupImpl(host, {all: true, family: 4, verbatim: true}), controller.signal);
      diagnostic.reason = !Array.isArray(addresses) || !addresses.length || addresses.length > 20 ? 'dns_answers' : 'dns_address_denied';
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 20
          || addresses.some(row => row.family !== 4 || !publicAddress(row.address))) throw unavailable();
      const title = input.tool === 'read' ? articleUrl(input.url).title : null;
      const target = webSearch ? `https://${SEARCH_HOST}/html/?${new URLSearchParams({q: input.query})}` : input.tool === 'search'
        ? `https://${HOST}/w/api.php?${new URLSearchParams({action: 'query', format: 'json', formatversion: '2', list: 'search', srsearch: input.query, srlimit: '5', srprop: 'snippet', utf8: '1'})}`
        : `https://${HOST}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      diagnostic.phase = 'transport'; diagnostic.reason = 'transport_failure';
      const response = await abortable(fetchImpl(target, {signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: {accept: webSearch ? 'text/html' : 'application/json'}, address: addresses[0].address}), controller.signal);
      diagnostic.status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      try {
        const encoding = response?.headers?.get('content-encoding');
        diagnostic.encoding = encoding === null || encoding === undefined ? 'absent'
          : typeof encoding === 'string' && ['identity', 'gzip', 'br', 'deflate'].includes(encoding.trim().toLowerCase()) ? encoding.trim().toLowerCase() : 'other';
      } catch {diagnostic.encoding = 'other';}
      const data = await readBody(response, target, controller.signal, {html: webSearch, diagnostic});
      if (webSearch) {
        const results = webResults(data, diagnostic);
        return {ok: true, tool: 'search', source: 'DuckDuckGo web search', query: input.query, results,
          citations: results.map(({title, url}) => ({title, url}))};
      }
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
      if (signal?.aborted) diagnostic.reason = 'cancelled';
      else if (timedOut) diagnostic.reason = 'deadline';
      // An observer cannot alter the customer result or cause an unhandled rejection.
      try {Promise.resolve(observeFailure(Object.freeze({...diagnostic}))).catch(() => {});} catch {}
      if (error instanceof ResearchToolError) throw error;
      throw unavailable();
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();}
  }
  return Object.freeze({execute});
}

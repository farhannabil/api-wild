import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createResearchTools, validateResearchToolInput, RESEARCH_TOOL_METADATA} from '../infra/railway/runtime/research-tools.mjs';
import {GatewayError} from '../infra/railway/runtime/supabase-gateway-rpc.mjs';

const publicLookup = async () => [{address: '208.80.154.224', family: 4}];
const response = (url, value, override = {}) => ({url, status: 200, ok: true,
  headers: new Headers({'content-type': 'application/json'}),
  body: new Response(JSON.stringify(value)).body, ...override});
const searchData = {query: {search: [{title: 'Canada', snippet: '<span>Canada</span> &amp; "Québec"'}]}};
function fixture(data = searchData, override = {}) {
  const calls = [];
  const utility = createResearchTools({lookupImpl: publicLookup, fetchImpl: async (url, options) => {
    calls.push({url, options}); return response(url, data, override);
  }});
  return {utility, calls};
}
const rejectCode = (operation, code = 'research_tools_invalid_input', status = 400) =>
  assert.rejects(operation, error => error instanceof GatewayError && error.code === code && error.status === status);

// Structural fixture taken from an actual official DuckDuckGo HTML response:
// organic web-result cards, result__a and result__snippet, plus encoded /l/ links.
const webCard = (url = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.canada.ca%2Fen.html&amp;rut=abc',
  title = 'Home - Canada.ca', snippet = '<b>Official</b> Government of Canada website.', extraClass = '') =>
  `<div class="result results_links results_links_deep web-result ${extraClass}"><div class="links_main result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="${url}">${title}</a></h2><a class="result__snippet" href="${url}">${snippet}</a></div></div>`;
function webFixture(html = webCard(), override = {}) {
  const calls = [], hosts = [];
  const utility = createResearchTools({lookupImpl: async host => {hosts.push(host); return publicLookup();}, fetchImpl: async (url, options) => {
    calls.push({url, options}); return response(url, null, {headers: new Headers({'content-type': 'text/html; charset=UTF-8'}), body: new Response(html).body, ...override});
  }});
  return {utility, calls, hosts};
}

test('default search returns general web results and decodes redirects locally without visiting result sites', async () => {
  const {utility, calls, hosts} = webFixture();
  const result = await utility.execute({tool: 'search', query: 'Canada official "&" government'});
  assert.equal(result.source, 'DuckDuckGo web search');
  assert.deepEqual(result.results, [{title: 'Home - Canada.ca', url: 'https://www.canada.ca/en.html', snippet: 'Official Government of Canada website.'}]);
  assert.deepEqual(result.citations, [{title: 'Home - Canada.ca', url: 'https://www.canada.ca/en.html'}]);
  assert.deepEqual(hosts, ['html.duckduckgo.com']);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/html/');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'Canada official "&" government');
  assert.equal(calls[0].options.headers.accept, 'text/html');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
});

test('web results are bounded, deduplicated, sanitized and exclude advertisements', async () => {
  const html = webCard('https://ads.microsoft.com/', 'Ad', '', 'result--ad') + webCard() + webCard()
    + Array.from({length: 7}, (_, index) => webCard(`http://www.mozilla.org/article${index}?a=1&amp;b=2`,
      'A &quot;title&quot; &#x1f1e8; &#127464;' + 'x'.repeat(400), '<script>private();</script><b>Context</b>' + 'x'.repeat(700))).join('');
  const result = await webFixture(html).utility.execute({tool: 'search', query: 'test', source: 'web'});
  assert.equal(result.results.length, 5);
  assert.equal(result.results[0].title, 'Home - Canada.ca');
  assert.equal(result.results[1].url, 'http://www.mozilla.org/article0?a=1&b=2');
  assert.equal(result.results[1].title.length, 300);
  assert.equal(result.results[1].snippet.length, 600);
  assert.ok(!result.results[1].snippet.includes('private'));
  assert.ok(result.results[1].title.startsWith('A "title"'));
});

test('unsafe and malformed web links are never returned or fetched', async () => {
  const bad = ['javascript:alert(1)', 'data:text/html,hello', 'ftp://www.mozilla.org/', 'https://user:pass@www.mozilla.org/',
    'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://169.254.169.254/', 'https://localhost/',
    'https://server.local/', 'https://server.internal/', 'https://server.lan/', 'https://server.home/', 'https://www.mozilla.org:444/', 'https://www.mozilla.org./',
    '/relative', '//duckduckgo.com/l/?uddg=javascript%3Aalert(1)', '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.mozilla.org%2F&amp;uddg=https%3A%2F%2Fgithub.com%2F',
    '//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2F%0Asecret', 'https://www.mozilla.org/&#10;secret'];
  const {utility, calls} = webFixture(bad.map(url => webCard(url)).join('') + webCard('https://github.com/', 'Safe'));
  const result = await utility.execute({tool: 'search', query: 'test'});
  assert.deepEqual(result.results.map(row => row.url), ['https://github.com/']);
  assert.equal(calls.length, 1);
});

test('web challenges, unknown markup and redirects fail closed; explicit no-results is supported', async () => {
  for (const html of ['<form id="challenge-form">solve this</form>', '<div class="anomaly-modal">Challenge</div>', '<html>Something changed</html>', webCard('javascript:alert(1)')]) {
    await rejectCode(() => webFixture(html).utility.execute({tool: 'search', query: 'test'}), 'research_tools_source_unavailable', 503);
  }
  assert.deepEqual((await webFixture('<div class="no-results">No results found</div>').utility.execute({tool: 'search', query: 'test'})).results, []);
  for (const override of [{status: 202, ok: false}, {status: 302, ok: false}, {url: 'https://duckduckgo.com/anomaly'}, {headers: new Headers({'content-type': 'application/json'})}]) {
    await rejectCode(() => webFixture(webCard(), override).utility.execute({tool: 'search', query: 'test'}), 'research_tools_source_unavailable', 503);
  }
});

test('web source selection is strict and response bytes remain bounded', async () => {
  for (const input of [{tool: 'search', query: 'test', source: 'unknown'}, {tool: 'read', url: 'https://en.wikipedia.org/wiki/Canada', source: 'web'}, {tool: 'calculate', expression: '1+1', source: 'web'}]) {
    assert.throws(() => validateResearchToolInput(input), error => error.code === 'research_tools_invalid_input');
  }
  await rejectCode(() => webFixture(webCard(), {headers: new Headers({'content-type': 'text/html', 'content-length': '262145'})}).utility.execute({tool: 'search', query: 'test'}), 'research_tools_too_large', 413);
  await rejectCode(() => webFixture('x'.repeat(262145)).utility.execute({tool: 'search', query: 'test'}), 'research_tools_too_large', 413);
});

test('production web transport retains its TLS hostname while pinning the vetted address', async () => {
  const previous = https.get; let captured;
  https.get = (url, options, callback) => {
    captured = {url, options};
    const incoming = Readable.from([Buffer.from(webCard())]);
    incoming.statusCode = 200; incoming.headers = {'content-type': 'text/html'};
    queueMicrotask(() => callback(incoming)); return new EventEmitter();
  };
  try {
    const result = await createResearchTools({lookupImpl: publicLookup}).execute({tool: 'search', query: 'Canada'});
    assert.equal(result.results[0].url, 'https://www.canada.ca/en.html');
    assert.equal(captured.options.servername, 'html.duckduckgo.com');
    assert.equal(captured.options.rejectUnauthorized, true);
    assert.equal(captured.options.agent, false);
    assert.equal(captured.options.headers.authorization, undefined);
    assert.equal(captured.options.headers.cookie, undefined);
    assert.equal(captured.options.headers.accept, 'text/html');
    const address = await new Promise((resolve, reject) => captured.options.lookup('html.duckduckgo.com', {}, (error, ip, family) => error ? reject(error) : resolve({ip, family})));
    assert.deepEqual(address, {ip: '208.80.154.224', family: 4});
  } finally {https.get = previous;}
});

test('metadata separates general web search from the restricted read-only article reader', () => {
  assert.equal(RESEARCH_TOOL_METADATA.searchSource, 'DuckDuckGo web search');
  assert.deepEqual(RESEARCH_TOOL_METADATA.searchSources, ['web', 'wikipedia']);
  assert.equal(RESEARCH_TOOL_METADATA.modelCalls, false);
  assert.deepEqual(RESEARCH_TOOL_METADATA.allowedReadHosts, ['en.wikipedia.org']);
  assert.ok(Object.isFrozen(RESEARCH_TOOL_METADATA.tools));
});

test('search encodes the query, returns bounded text and exact public citations', async () => {
  const {utility, calls} = fixture();
  const result = await utility.execute({tool: 'search', source: 'wikipedia', query: 'Canada "&" Montréal'});
  assert.deepEqual(result.results, [{title: 'Canada', url: 'https://en.wikipedia.org/wiki/Canada', snippet: 'Canada & "Québec"'}]);
  assert.deepEqual(result.citations, [{title: 'Canada', url: 'https://en.wikipedia.org/wiki/Canada'}]);
  const target = new URL(calls[0].url);
  assert.equal(target.hostname, 'en.wikipedia.org');
  assert.equal(target.searchParams.get('srsearch'), 'Canada "&" Montréal');
  assert.equal(target.searchParams.get('srlimit'), '5');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0].options.headers), ['accept']);
});

test('article reader retrieves a summary and cites the validated URL', async () => {
  const {utility, calls} = fixture({type: 'standard', title: 'Canada', extract: 'A '.repeat(4000)});
  const result = await utility.execute({tool: 'read', url: 'https://en.wikipedia.org/wiki/Canada'});
  assert.equal(result.source, 'English Wikipedia article summary');
  assert.equal(result.text.length, 6000);
  assert.equal(result.truncated, true);
  assert.equal(result.citations[0].url, result.url);
  assert.equal(new URL(calls[0].url).pathname, '/api/rest_v1/page/summary/Canada');
});

test('calculator supports precedence, signs and fractions without network', async () => {
  const utility = createResearchTools({lookupImpl: () => {throw Error('No DNS permitted');}, fetchImpl: () => {throw Error('No network permitted');}});
  for (const [expression, expected] of [['(3 + 5) * 2', 16], ['-.5 + 2 / 4', 0], ['10 % 3', 1], ['2*-3', -6]]) {
    assert.equal((await utility.execute({tool: 'calculate', expression})).result, expected);
  }
});

test('calculator rejects execution, invalid arithmetic and excessive complexity', async () => {
  const {utility, calls} = fixture();
  for (const expression of ['process.exit()', '1/0', '1%0', '1e10', '2**4', '2(3)', '1.2.3', '1 2', '1 .2', '1000000000000*2', '('.repeat(17) + '1' + ')'.repeat(17), '1+'.repeat(33) + '1']) {
    await rejectCode(() => utility.execute({tool: 'calculate', expression}));
  }
  assert.equal(calls.length, 0);
});

test('strict input validation rejects extra fields, getters and inherited objects', () => {
  for (const input of [null, [], {tool: 'shell', query: 'ls'}, {tool: 'search', source: 'wikipedia', query: 'test', secret: 'private'},
    {tool: 'search', source: 'wikipedia', query: 'test', expression: '1+2'}, {tool: 'search', source: 'wikipedia', query: 'x'.repeat(201)},
    {tool: 'search', source: 'wikipedia', query: 'a\nsecret'}, Object.create({tool: 'search', source: 'wikipedia', query: 'test'})]) {
    assert.throws(() => validateResearchToolInput(input), error => error.code === 'research_tools_invalid_input');
  }
  const getter = {tool: 'search'};
  Object.defineProperty(getter, 'query', {enumerable: true, get: () => {throw Error('Getter must never run');}});
  assert.throws(() => validateResearchToolInput(getter), error => error.code === 'research_tools_invalid_input');
});

test('read rejects private, arbitrary, credential-bearing and ambiguous URLs before transport', async () => {
  const {utility, calls} = fixture();
  for (const url of ['http://en.wikipedia.org/wiki/Canada', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data/',
    'https://evil.example/wiki/Canada', 'https://en.wikipedia.org.evil.example/wiki/Canada', 'https://en.wikipedia.org./wiki/Canada',
    'https://user:password@en.wikipedia.org/wiki/Canada', 'https://en.wikipedia.org:444/wiki/Canada',
    'https://en.wikipedia.org/wiki/Canada?next=https://localhost/', 'https://en.wikipedia.org/wiki/Canada#secret',
    'https://en.wikipedia.org/wiki/Category:Canada', 'https://en.wikipedia.org/wiki/a%2fb', 'https://en.wikipedia.org/wiki/%00',
    'https://en.wikipedia.org/w/api.php']) await rejectCode(() => utility.execute({tool: 'read', url}));
  assert.equal(calls.length, 0);
});

test('all DNS answers must be global IPv4; mixed public/private answers fail closed', async () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1',
    '100.64.0.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1']) {
    let fetched = false;
    const utility = createResearchTools({lookupImpl: async () => [...await publicLookup(), {address, family: address === '::1' ? 6 : 4}],
      fetchImpl: () => {fetched = true;}});
    await rejectCode(() => utility.execute({tool: 'search', source: 'wikipedia', query: 'test'}), 'research_tools_source_unavailable', 503);
    assert.equal(fetched, false);
  }
});

test('production HTTPS transport pins the verified DNS address and sends no auth headers', async () => {
  const previous = https.get; let captured;
  https.get = (url, options, callback) => {
    captured = {url, options};
    const incoming = Readable.from([Buffer.from(JSON.stringify(searchData))]);
    incoming.statusCode = 200; incoming.headers = {'content-type': 'application/json'};
    queueMicrotask(() => callback(incoming)); return new EventEmitter();
  };
  try {
    const result = await createResearchTools({lookupImpl: publicLookup}).execute({tool: 'search', source: 'wikipedia', query: 'Canada'});
    assert.equal(result.results.length, 1);
    const address = await new Promise((resolve, reject) => captured.options.lookup('untrusted-rebind.example', {}, (error, ip, family) => error ? reject(error) : resolve({ip, family})));
    assert.deepEqual(address, {ip: '208.80.154.224', family: 4});
    const all = await new Promise((resolve, reject) => captured.options.lookup('en.wikipedia.org', {all: true}, (error, rows) => error ? reject(error) : resolve(rows)));
    assert.deepEqual(all, [{address: '208.80.154.224', family: 4}]);
    assert.equal(captured.options.agent, false);
    assert.equal(captured.options.rejectUnauthorized, true);
    assert.equal(captured.options.servername, 'en.wikipedia.org');
    assert.equal(captured.options.headers.authorization, undefined);
    assert.equal(captured.options.headers.cookie, undefined);
  } finally {https.get = previous;}
});

test('redirects, identity changes, non-JSON and upstream failures are rejected', async () => {
  for (const override of [{status: 302, ok: false}, {url: 'https://localhost/'}, {status: 500, ok: false},
    {headers: new Headers({'content-type': 'text/html'})}]) {
    await rejectCode(() => fixture(searchData, override).utility.execute({tool: 'search', source: 'wikipedia', query: 'Canada'}), 'research_tools_source_unavailable', 503);
  }
});

test('provider results are strictly bounded and article ambiguity is not silently accepted', async () => {
  for (const data of [{query: {search: Array(6).fill(searchData.query.search[0])}}, {query: {search: [{title: 'https://evil.example', snippet: 'bad'}]}},
    {query: {search: [{title: 'Canada', snippet: null}]}}, {error: {info: 'private provider text'}}]) {
    await assert.rejects(() => fixture(data).utility.execute({tool: 'search', source: 'wikipedia', query: 'Canada'}), error => error instanceof GatewayError);
  }
  await rejectCode(() => fixture({type: 'disambiguation', title: 'Test', extract: 'Pick one'}).utility.execute({tool: 'read', url: 'https://en.wikipedia.org/wiki/Test'}), 'research_tools_source_unavailable', 503);
});

test('declared and streamed response sizes are limited', async () => {
  await rejectCode(() => fixture(searchData, {headers: new Headers({'content-type': 'application/json', 'content-length': '65537'})}).utility.execute({tool: 'search', source: 'wikipedia', query: 'test'}), 'research_tools_too_large', 413);
  await rejectCode(() => fixture({query: {search: []}, ignored: 'x'.repeat(65536)}).utility.execute({tool: 'search', source: 'wikipedia', query: 'test'}), 'research_tools_too_large', 413);
});

test('deadline bounds DNS and response waiting, and abort propagates to fetch', async () => {
  const hungDns = createResearchTools({timeoutMs: 100, lookupImpl: () => new Promise(() => {}), fetchImpl: () => {throw Error('No fetch');}});
  const started = Date.now();
  await rejectCode(() => hungDns.execute({tool: 'search', source: 'wikipedia', query: 'test'}), 'research_tools_source_unavailable', 503);
  assert.ok(Date.now() - started < 1500);
  let fetchSignal;
  const hungFetch = createResearchTools({timeoutMs: 100, lookupImpl: publicLookup, fetchImpl: (_url, {signal}) => {
    fetchSignal = signal; return new Promise(() => {});
  }});
  await rejectCode(() => hungFetch.execute({tool: 'search', source: 'wikipedia', query: 'test'}), 'research_tools_source_unavailable', 503);
  assert.equal(fetchSignal.aborted, true);
  const controller = new AbortController(); controller.abort();
  await rejectCode(() => fixture().utility.execute({tool: 'search', source: 'wikipedia', query: 'test'}, {signal: controller.signal}), 'research_tools_source_unavailable', 503);
});

test('raw upstream errors are replaced with a stable sanitized gateway error', async () => {
  const utility = createResearchTools({lookupImpl: publicLookup, fetchImpl: () => {throw Error('secret key and private network details');}});
  await assert.rejects(() => utility.execute({tool: 'search', source: 'wikipedia', query: 'test'}), error => error.message === 'research_tools_source_unavailable' && error.status === 503);
});

test('deadline also bounds a stalled response body', async () => {
  let cancelled = false;
  const utility = createResearchTools({timeoutMs: 100, lookupImpl: publicLookup, fetchImpl: async url => response(url, {}, {
    body: new ReadableStream({pull() {return new Promise(() => {});}, cancel() {cancelled = true;}}),
  })});
  await rejectCode(() => utility.execute({tool: 'search', source: 'wikipedia', query: 'test'}), 'research_tools_source_unavailable', 503);
  assert.equal(cancelled, true);
});

test('failure diagnostics distinguish transport, response, parser and bounds without source data', async () => {
  const secret = 'private-query-secret-token';
  const cases = [
    {phase: 'dns', reason: 'dns_failure', lookupImpl: async () => {throw Error(secret);}},
    {phase: 'dns', reason: 'dns_answers', lookupImpl: async () => []},
    {phase: 'dns', reason: 'dns_answers', lookupImpl: async () => Array(21).fill({address: '208.80.154.224', family: 4})},
    {phase: 'dns', reason: 'dns_address_denied', lookupImpl: async () => [{address: '127.0.0.1', family: 4}]},
    {phase: 'transport', reason: 'transport_failure', fetchImpl: async () => {throw Error(secret);}},
    {phase: 'response', reason: 'response_status', override: {status: 202, ok: false}, status: 202},
    {phase: 'response', reason: 'response_shape', fetchImpl: async () => null},
    {phase: 'response', reason: 'response_identity', override: {url: `https://${secret}.com/`}, status: 200},
    {phase: 'response', reason: 'content_type', override: {headers: new Headers({'content-type': secret})}, status: 200},
    {phase: 'response', reason: 'body_limit', override: {headers: new Headers({'content-type': 'text/html', 'content-length': '262145'})}, status: 200, code: 'research_tools_too_large', httpStatus: 413},
    {phase: 'body', reason: 'body_missing', override: {body: null}, status: 200},
    {phase: 'body', reason: 'body_failure', override: {body: new ReadableStream({start(controller) {controller.error(Error(secret));}})}, status: 200},
    {phase: 'body', reason: 'body_limit', html: 'x'.repeat(262145), status: 200, code: 'research_tools_too_large', httpStatus: 413},
    {phase: 'parse', reason: 'challenge', html: `<form id="challenge-form">${secret}</form>`, status: 200},
    {phase: 'parse', reason: 'unknown_markup', html: `<html>${secret}</html>`, status: 200},
  ];
  for (const item of cases) {
    const events = [];
    const utility = createResearchTools({observeFailure: event => events.push(event), lookupImpl: item.lookupImpl || publicLookup,
      fetchImpl: item.fetchImpl || (async url => response(url, null, {headers: new Headers({'content-type': 'text/html'}), body: new Response(item.html || webCard()).body, ...item.override}))});
    await rejectCode(() => utility.execute({tool: 'search', query: secret}), item.code || 'research_tools_source_unavailable', item.httpStatus || 503);
    assert.deepEqual(events, [{researchToolFailure: true, source: 'web', phase: item.phase, reason: item.reason, status: item.status ?? null, encoding: 'absent'}]);
    assert.ok(Object.isFrozen(events[0]));
    assert.ok(!JSON.stringify(events).includes(secret));
  }
});

test('diagnostics sanitize content encoding and malformed source payloads', async () => {
  for (const [encoding, safe] of [[' GZip ', 'gzip'], ['br', 'br'], ['deflate', 'deflate'], ['identity', 'identity'], ['secret-header-value', 'other']]) {
    const events = [];
    const utility = createResearchTools({observeFailure: event => events.push(event), lookupImpl: publicLookup,
      fetchImpl: async url => response(url, null, {headers: new Headers({'content-type': 'application/json', 'content-encoding': encoding}), body: new Response('{invalid private body').body})});
    await rejectCode(() => utility.execute({tool: 'search', source: 'wikipedia', query: 'private query'}), 'research_tools_source_unavailable', 503);
    assert.deepEqual(events, [{researchToolFailure: true, source: 'wikipedia', phase: 'parse', reason: 'invalid_payload', status: 200, encoding: safe}]);
  }
});

test('deadline and customer cancellation retain their failure phase with fixed reasons', async () => {
  for (const phase of ['dns', 'transport', 'body']) {
    const events = [];
    const utility = createResearchTools({timeoutMs: 100, observeFailure: event => events.push(event),
      lookupImpl: phase === 'dns' ? () => new Promise(() => {}) : publicLookup,
      fetchImpl: phase === 'transport' ? () => new Promise(() => {}) : async url => response(url, null, {body: new ReadableStream({pull() {return new Promise(() => {});}})})});
    await rejectCode(() => utility.execute({tool: 'search', source: 'wikipedia', query: 'private query'}), 'research_tools_source_unavailable', 503);
    assert.equal(events.length, 1); assert.equal(events[0].phase, phase); assert.equal(events[0].reason, 'deadline');
  }
  const events = [], controller = new AbortController();
  const utility = createResearchTools({observeFailure: event => events.push(event), lookupImpl: async () => {controller.abort(); return publicLookup();}});
  await rejectCode(() => utility.execute({tool: 'search', query: 'private query'}, {signal: controller.signal}), 'research_tools_source_unavailable', 503);
  assert.equal(events.length, 1); assert.equal(events[0].reason, 'cancelled');
});

test('observers are silent on valid results and cannot change failures by throwing or rejecting', async () => {
  const events = [];
  const utility = createResearchTools({observeFailure: event => events.push(event), lookupImpl: publicLookup,
    fetchImpl: async url => response(url, null, {headers: new Headers({'content-type': 'text/html'}), body: new Response('<div class="no-results">No results found</div>').body})});
  assert.deepEqual((await utility.execute({tool: 'search', query: 'test'})).results, []);
  assert.equal((await utility.execute({tool: 'calculate', expression: '1+1'})).result, 2);
  assert.deepEqual(events, []);
  for (const observeFailure of [() => {throw Error('observer-secret');}, () => Promise.reject(Error('observer-secret'))]) {
    const failing = createResearchTools({observeFailure, lookupImpl: publicLookup, fetchImpl: async () => {throw Error('upstream-secret');}});
    await rejectCode(() => failing.execute({tool: 'search', query: 'private query'}), 'research_tools_source_unavailable', 503);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => createResearchTools({observeFailure: null}), /Invalid research utility configuration/);
});

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

test('metadata identifies the limited source and read-only behavior', () => {
  assert.equal(RESEARCH_TOOL_METADATA.searchSource, 'English Wikipedia');
  assert.equal(RESEARCH_TOOL_METADATA.modelCalls, false);
  assert.deepEqual(RESEARCH_TOOL_METADATA.allowedReadHosts, ['en.wikipedia.org']);
  assert.ok(Object.isFrozen(RESEARCH_TOOL_METADATA.tools));
});

test('search encodes the query, returns bounded text and exact public citations', async () => {
  const {utility, calls} = fixture();
  const result = await utility.execute({tool: 'search', query: 'Canada "&" Montréal'});
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
  for (const input of [null, [], {tool: 'shell', query: 'ls'}, {tool: 'search', query: 'test', secret: 'private'},
    {tool: 'search', query: 'test', expression: '1+2'}, {tool: 'search', query: 'x'.repeat(201)},
    {tool: 'search', query: 'a\nsecret'}, Object.create({tool: 'search', query: 'test'})]) {
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
    await rejectCode(() => utility.execute({tool: 'search', query: 'test'}), 'research_tools_source_unavailable', 503);
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
    const result = await createResearchTools({lookupImpl: publicLookup}).execute({tool: 'search', query: 'Canada'});
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
    await rejectCode(() => fixture(searchData, override).utility.execute({tool: 'search', query: 'Canada'}), 'research_tools_source_unavailable', 503);
  }
});

test('provider results are strictly bounded and article ambiguity is not silently accepted', async () => {
  for (const data of [{query: {search: Array(6).fill(searchData.query.search[0])}}, {query: {search: [{title: 'https://evil.example', snippet: 'bad'}]}},
    {query: {search: [{title: 'Canada', snippet: null}]}}, {error: {info: 'private provider text'}}]) {
    await assert.rejects(() => fixture(data).utility.execute({tool: 'search', query: 'Canada'}), error => error instanceof GatewayError);
  }
  await rejectCode(() => fixture({type: 'disambiguation', title: 'Test', extract: 'Pick one'}).utility.execute({tool: 'read', url: 'https://en.wikipedia.org/wiki/Test'}), 'research_tools_source_unavailable', 503);
});

test('declared and streamed response sizes are limited', async () => {
  await rejectCode(() => fixture(searchData, {headers: new Headers({'content-type': 'application/json', 'content-length': '65537'})}).utility.execute({tool: 'search', query: 'test'}), 'research_tools_too_large', 413);
  await rejectCode(() => fixture({query: {search: []}, ignored: 'x'.repeat(65536)}).utility.execute({tool: 'search', query: 'test'}), 'research_tools_too_large', 413);
});

test('deadline bounds DNS and response waiting, and abort propagates to fetch', async () => {
  const hungDns = createResearchTools({timeoutMs: 100, lookupImpl: () => new Promise(() => {}), fetchImpl: () => {throw Error('No fetch');}});
  const started = Date.now();
  await rejectCode(() => hungDns.execute({tool: 'search', query: 'test'}), 'research_tools_source_unavailable', 503);
  assert.ok(Date.now() - started < 1500);
  let fetchSignal;
  const hungFetch = createResearchTools({timeoutMs: 100, lookupImpl: publicLookup, fetchImpl: (_url, {signal}) => {
    fetchSignal = signal; return new Promise(() => {});
  }});
  await rejectCode(() => hungFetch.execute({tool: 'search', query: 'test'}), 'research_tools_source_unavailable', 503);
  assert.equal(fetchSignal.aborted, true);
  const controller = new AbortController(); controller.abort();
  await rejectCode(() => fixture().utility.execute({tool: 'search', query: 'test'}, {signal: controller.signal}), 'research_tools_source_unavailable', 503);
});

test('raw upstream errors are replaced with a stable sanitized gateway error', async () => {
  const utility = createResearchTools({lookupImpl: publicLookup, fetchImpl: () => {throw Error('secret key and private network details');}});
  await assert.rejects(() => utility.execute({tool: 'search', query: 'test'}), error => error.message === 'research_tools_source_unavailable' && error.status === 503);
});

test('deadline also bounds a stalled response body', async () => {
  let cancelled = false;
  const utility = createResearchTools({timeoutMs: 100, lookupImpl: publicLookup, fetchImpl: async url => response(url, {}, {
    body: new ReadableStream({pull() {return new Promise(() => {});}, cancel() {cancelled = true;}}),
  })});
  await rejectCode(() => utility.execute({tool: 'search', query: 'test'}), 'research_tools_source_unavailable', 503);
  assert.equal(cancelled, true);
});

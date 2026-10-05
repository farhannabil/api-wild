import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {preparationResponse, createPreparationServer, proxyHeaders, loadPublicAssets, preparationListenOptions} from './preparation-server.mjs';
import {env, publicSupabaseConfig} from './preparation-env.mjs';
import {inspectPreparation} from './preflight.mjs';

test('liveness does not claim readiness', () => {
  assert.deepEqual(preparationResponse({url: '/health/live'}), {
    status: 200, body: {alive: true, ready: false, phase: 'railway-preparation'},
  });
});
for (const url of ['/health/ready', '/api/account', '/api/keys',
  '/api/billing/checkout', '/api/billing/webhook', '/api/aaro/usage', '/api/gateway', '/v1/chat/completions',
  '/api/%62illing/checkout', '/%61pi/keys', '/%2561pi/gateway', '/health/live?ready=true']) {
  test(`application and ambiguous routes remain closed: ${url}`, () => {
    const result = preparationResponse({url});
    assert.equal(result.status, 503); assert.equal(result.body.ready, false);
  });
}
for (const url of ['/', '/pricing', '/models', '/login', '/signup', '/console', '/assets/fixture.svg', '/api/supabase-config']) {
  test(`approved UI/direct Auth configuration may reach loopback preview: ${url}`, () => {
    assert.deepEqual(preparationResponse({url}), {action: 'proxy'});
  });
}
for (const url of ['//example.invalid/health/live', '/api\\keys', '/%00', '/%not-valid']) {
  test(`ambiguous request path rejected: ${url}`, () => assert.equal(preparationResponse({url}).status, 400));
}
for (const name of ['oai-authenticated-user-id', 'OAI-Authenticated-User-Email', 'oai-authenticated-role']) {
  test(`spoofable identity header rejected: ${name}`, () => {
    assert.equal(preparationResponse({url: '/health/live', headers: {[name]: 'fixture-only'}}).status, 403);
  });
}
test('POST and other methods never invoke application handlers', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(preparationResponse({method, url: '/health/live'}).status, 503);
  }
});
test('preparation environment cannot accept database/keys or activate commerce', () => {
  assert.equal(Object.getPrototypeOf(env), null); assert.ok(Object.isFrozen(env));
  for (const key of ['COMMERCE_READY', 'BILLING_ENABLED', 'GATEWAY_ENABLED', 'AARO_BILLING_ENABLED', 'AARO_USAGE_ENABLED']) assert.equal(env[key], 'false');
  for (const key of ['DB', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'SUBROUTER_API_KEY']) {
    assert.equal(env[key], undefined);
  }
  assert.throws(() => {env.COMMERCE_READY = 'true';}, TypeError);
});
test('public Auth config accepts only intended project and public keys', () => {
  const source = {SUPABASE_URL: 'https://yautmilnpllojugpmfgy.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture_only'};
  assert.deepEqual(publicSupabaseConfig(source), source);
  assert.deepEqual(publicSupabaseConfig({...source, SUPABASE_URL: 'https://bheheypylmibuicqtywx.supabase.co'}), {});
  assert.deepEqual(publicSupabaseConfig({...source, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fixture_only'}), {});
  const jwt = role => 'fixture.' + Buffer.from(JSON.stringify({role, ref: 'yautmilnpllojugpmfgy'})).toString('base64url') + '.fixture';
  assert.deepEqual(publicSupabaseConfig({...source, SUPABASE_PUBLISHABLE_KEY: jwt('service_role')}), {});
  assert.equal(publicSupabaseConfig({...source, SUPABASE_PUBLISHABLE_KEY: jwt('anon')}).SUPABASE_URL, source.SUPABASE_URL);
});
test('UI proxy strips untrusted identity, proxy and customer auth headers', () => {
  const result = proxyHeaders({'oai-authenticated-user-id': 'fixture', 'OAI-Authenticated-User-Email': 'fixture',
    authorization: 'fixture', cookie: 'fixture', host: 'evil.invalid', 'x-forwarded-host': 'evil.invalid',
    'x-forwarded-proto': 'http', connection: 'upgrade', upgrade: 'fixture', accept: 'text/html'});
  assert.deepEqual(result, {accept: 'text/html', host: 'apiwild.com'});
});
test('creating the native server never opens a listener', () => {
  const server = createPreparationServer(); assert.equal(server.listening, false); server.close();
});

test('explicit local mode binds only loopback without changing the Railway listener', () => {
  assert.deepEqual(preparationListenOptions(['--local']), {port: 4318, host: '127.0.0.1', local: true});
  assert.deepEqual(preparationListenOptions([]), {port: 3000, host: '0.0.0.0', local: false});
  assert.deepEqual(preparationListenOptions(['--local'], {PORT: '4320'}), {port: 4320, host: '127.0.0.1', local: true});
  assert.ok(Object.isFrozen(preparationListenOptions(['--local'])));
});

test('local startup rejects ambiguous arguments and invalid listener ports', () => {
  for (const args of [['--local', '--local'], ['--host', '0.0.0.0'], ['--local=true'], ['--production'], null]) {
    assert.throws(() => preparationListenOptions(args), /arguments/);
  }
  for (const PORT of ['0', '-1', '65536', '4318junk', ' 4318', '04318', 4318, 0, false, null]) {
    assert.throws(() => preparationListenOptions(['--local'], {PORT}), /port/);
  }
});

async function assetFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apiwild-assets-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('apiwild-assets-test-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  const client = path.join(root, 'client');
  await fs.mkdir(path.join(client, 'assets'), {recursive: true});
  return {root, client};
}

test('public snapshot uses canonical slash keys and excludes non-public formats', async t => {
  const {client} = await assetFixture(t);
  await fs.mkdir(path.join(client, 'models', 'previews'), {recursive: true});
  await fs.writeFile(path.join(client, 'assets', 'index-fixture.css'), 'body{color:blue}');
  await fs.writeFile(path.join(client, 'assets', 'index-fixture.js'), 'export const fixture=true;');
  await fs.writeFile(path.join(client, 'models', 'previews', 'fixture.webp'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(client, 'favicon.svg'), '<svg/>');
  for (const name of ['source.js.map', 'private.json', 'document.html', '.private.js']) {
    await fs.writeFile(path.join(client, 'assets', name), 'not-public');
  }
  const assets = await loadPublicAssets(client);
  assert.equal(assets.count, 4);
  assert.equal(assets.lookup('/assets/index-fixture.css').type, 'text/css; charset=utf-8');
  assert.equal(assets.lookup('/assets/index-fixture.css?cache=no').body.toString(), 'body{color:blue}');
  assert.equal(assets.lookup('/models/previews/fixture.webp').type, 'image/webp');
  assert.equal(assets.lookup('/favicon.svg').type, 'image/svg+xml');
  for (const url of ['/assets\\index-fixture.css', '/assets/../favicon.svg', '/assets/%69ndex-fixture.css',
    '/assets/%2569ndex-fixture.css', '//assets/index-fixture.css', '/assets/./index-fixture.css',
    '/assets/source.js.map', '/assets/private.json', '/assets/document.html', '/assets/.private.js',
    '/dist/server/index.js', '/assets/not-present.js']) assert.equal(assets.lookup(url), undefined, url);
  // Requests read the closed startup snapshot, not a subsequently replaced file.
  await fs.writeFile(path.join(client, 'assets', 'index-fixture.css'), 'changed-on-disk');
  assert.equal(assets.lookup('/assets/index-fixture.css').body.toString(), 'body{color:blue}');
});

test('public snapshot skips outside symlink/junction directories and rejects a linked root', async t => {
  const {root, client} = await assetFixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.js'), 'outside-not-public');
  await fs.symlink(outside, path.join(client, 'escaped'), 'junction');
  const assets = await loadPublicAssets(client);
  assert.equal(assets.count, 0);
  assert.equal(assets.lookup('/escaped/private.js'), undefined);
  await fs.symlink(outside, path.join(root, 'linked-client'), 'junction');
  await assert.rejects(loadPublicAssets(path.join(root, 'linked-client')), /Invalid public asset directory/);
});

test('public asset files are bounded before buffering', async t => {
  const {client} = await assetFixture(t);
  const handle = await fs.open(path.join(client, 'assets', 'large.js'), 'w');
  try { await handle.truncate(8 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(loadPublicAssets(client), /byte limit exceeded/);
});

test('public asset aggregate bytes are bounded', async t => {
  const {client} = await assetFixture(t);
  for (let i = 0; i < 5; i++) {
    const handle = await fs.open(path.join(client, 'assets', `large-${i}.js`), 'w');
    try { await handle.truncate(8 * 1024 * 1024); } finally { await handle.close(); }
  }
  await assert.rejects(loadPublicAssets(client), /byte limit exceeded/);
});

test('public asset entry and depth scans are finite', async t => {
  const {root, client} = await assetFixture(t);
  for (let i = 0; i < 1025; i += 32) {
    await Promise.all(Array.from({length: Math.min(32, 1025 - i)}, (_, offset) =>
      fs.writeFile(path.join(client, `.ignored-${i + offset}`), '')));
  }
  await assert.rejects(loadPublicAssets(client), /entry limit exceeded/);
  const deep = path.join(root, 'deep');
  await fs.mkdir(path.join(deep, ...Array(9).fill('nested')), {recursive: true});
  await assert.rejects(loadPublicAssets(deep), /depth limit exceeded/);
});

function localRequest(port, url, {method = 'GET', headers: incoming = {}} = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({hostname: '127.0.0.1', port, path: url, method, headers: incoming, agent: false,
      timeout: 2000}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Error('Local asset test timed out.')));
    request.end(incoming['content-length'] === '1' ? 'x' : undefined);
  });
}

test('native wrapper serves public CSS/JS GET and HEAD without bypassing closed gates', async t => {
  const {client} = await assetFixture(t);
  await fs.writeFile(path.join(client, 'assets', 'index-fixture.css'), 'body{color:blue}');
  await fs.writeFile(path.join(client, 'assets', 'index-fixture.js'), 'export const fixture=true;');
  const publicAssets = await loadPublicAssets(client);
  const server = createPreparationServer({publicAssets});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  for (const extension of ['css', 'js']) {
    const result = await localRequest(port, `/assets/index-fixture.${extension}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], extension === 'css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(Number(result.headers['content-length']), result.body.length);
    const head = await localRequest(port, `/assets/index-fixture.${extension}`, {method: 'HEAD'});
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], result.headers['content-length']);
  }
  for (const [url, options, status] of [
    ['/assets/index-fixture.css', {headers: {'oai-authenticated-user-id': 'fixture'}}, 403],
    ['/assets/index-fixture.css', {method: 'POST'}, 503],
    ['/assets/index-fixture.css', {headers: {'content-length': '1'}}, 503],
    ['/api/db', {}, 503], ['/api/keys', {}, 503], ['/health/ready', {}, 503],
    ['/assets/%69ndex-fixture.css', {}, 503], ['/assets/../index-fixture.css', {}, 503],
    ['/assets/missing.css', {}, 503], ['/assets\\index-fixture.css', {}, 400],
  ]) {
    const result = await localRequest(port, url, options);
    assert.equal(result.status, status, url);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal(JSON.parse((await localRequest(port, '/health/live')).body).ready, false);
});

function fixtureIo({missing = [], version = '0.0.50', integrity = 'sha512-Zml4dHVyZQ==', invalid = false} = {}) {
  return {
    access: async pathname => {if (missing.some(name => pathname.replaceAll('\\', '/').endsWith(name))) throw Error('missing');},
    readFile: async pathname => invalid ? '{invalid' : JSON.stringify(pathname.endsWith('package-lock.json') ? {
      packages: {'': {devDependencies: {vinext: version}}, 'node_modules/vinext': {version, integrity}},
    } : {devDependencies: {vinext: version}}),
  };
}
test('missing lock/catalog is a non-mutating preflight failure', async () => {
  const result = await inspectPreparation('fixture-root', fixtureIo({missing: ['package-lock.json', 'data/models.json']}));
  assert.equal(result.canBuildNodeArtifact, false); assert.equal(result.productionReady, false);
  assert.deepEqual(result.missing, ['package-lock.json', 'data/models.json']);
});
test('pinned artifact inputs never certify deployment acceptance', async () => {
  assert.deepEqual(await inspectPreparation('fixture-root', fixtureIo()), {canBuildNodeArtifact: true, productionReady: false});
});
for (const fixture of [{version: '0.0.51'}, {integrity: ''}, {invalid: true}]) {
  test(`incompatible dependency inputs remain blocked: ${JSON.stringify(fixture)}`, async () => {
    assert.equal((await inspectPreparation('fixture-root', fixtureIo(fixture))).canBuildNodeArtifact, false);
  });
}
test('fresh-service reference checks readiness and is not deprecated autoload config', async () => {
  const config = JSON.parse(await fs.readFile(new URL('./service-settings.reference.json', import.meta.url), 'utf8'));
  assert.equal(config.deploy.healthcheckPath, '/health/ready');
  assert.equal(preparationResponse({url: config.deploy.healthcheckPath}).status, 503);
  await assert.rejects(fs.access(new URL('../../railway.json', import.meta.url)), {code:'ENOENT'});
});

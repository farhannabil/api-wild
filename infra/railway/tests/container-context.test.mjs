import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);


test('welcome worker image includes its dynamically imported database adapter', async () => {
  const source = await readFile(new URL('infra/railway/resend-outbox.mjs', root), 'utf8');
  const ignore = (await readFile(new URL('infra/railway/Dockerfile.welcome.dockerignore', root), 'utf8')).split(/\r?\n/);
  const docker = await readFile(new URL('infra/railway/Dockerfile.welcome', root), 'utf8');
  for (const match of source.matchAll(/import\(['"](\.[^'"]+)['"]\)/g)) {
    const file = new URL(match[1], new URL('infra/railway/resend-outbox.mjs', root)).href.slice(root.href.length);
    assert.ok(ignore.includes('!' + file), 'Missing worker build source: ' + file);
    assert.ok(docker.includes('COPY ' + file + ' ./infra/railway/runtime/'), 'Missing worker runtime adapter: ' + file);
    await readFile(new URL(file, root));
  }
});

test('closed Docker context includes the catalogue imported by the application', async () => {
  const source = await readFile(new URL('lib/subrouter-catalogue-server.ts', root), 'utf8');
  const ignore = (await readFile(new URL('Dockerfile.railway.dockerignore', root), 'utf8')).split(/\r?\n/);
  assert.ok(source.includes('@/data/subrouter-catalogue.json'));
  assert.ok(ignore.includes('!data/subrouter-catalogue.json'));
});

test('closed Docker context and runtime contain preparation and operator import graphs', async () => {
  const ignore = (await readFile(new URL('Dockerfile.railway.dockerignore', root), 'utf8')).split(/\r?\n/);
  const docker = await readFile(new URL('Dockerfile.railway', root), 'utf8');
  const queue = ['infra/railway/preparation-server.mjs', 'infra/railway/allowance-worker.mjs', 'infra/railway/reservation-expiry.mjs', 'infra/railway/supplier-debit.mjs']; const visited = new Set();
  while (queue.length) {
    const file = queue.shift(); if (visited.has(file)) continue; visited.add(file);
    assert.ok(ignore.includes('!' + file), 'Missing build-context source: ' + file);
    const directoryCopy = file.startsWith('infra/railway/runtime/') && docker.includes('COPY --from=build /app/infra/railway/runtime ./infra/railway/runtime');
    assert.ok(directoryCopy || docker.includes('COPY --from=build /app/' + file + ' ./' + file), 'Missing runtime source: ' + file);
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const imported = new URL(match[1], new URL(file, root));
      assert.ok(imported.href.startsWith(root.href), 'Import escapes release root');
      queue.push(imported.href.slice(root.href.length));
    }
  }
  for (const excluded of ['**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.sqlite*', '**/*.db', '**/node_modules', '**/.git']) assert.ok(ignore.includes(excluded));
  for (const localOnly of ['infra/railway/sandbox-e2e.mjs','infra/railway/runtime/sandbox-e2e-harness.mjs']) {
    assert.ok(!ignore.includes('!'+localOnly), 'Local acceptance harness must not ship in production');
    assert.ok(!docker.includes('/app/'+localOnly), 'Local acceptance entry point must not be copied');
  }
});

test('candidate liveness never replaces the production readiness recipe', async () => {
  const candidate = JSON.parse(await readFile(new URL('infra/railway/candidate-settings.reference.json', root), 'utf8'));
  const production = JSON.parse(await readFile(new URL('infra/railway/service-settings.reference.json', root), 'utf8'));
  assert.equal(candidate.build.dockerfilePath, 'Dockerfile.railway');
  assert.equal(candidate.deploy.healthcheckPath, '/health/live');
  assert.equal(candidate.deploy.numReplicas, 1);
  assert.equal(candidate.deploy.restartPolicyType, 'NEVER');
  assert.equal(candidate.deploy.sleepApplication, true);
  assert.equal(production.deploy.healthcheckPath, '/health/ready');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const modules = ['preparation-server.mjs', 'runtime/aaro-usage-ingress.mjs', 'runtime/aaro-usage-bridge.mjs', 'runtime/stripe-webhook-ingress.mjs', 'runtime/stripe-projection-rpc.mjs', 'runtime/stripe-financial-projection.mjs', 'runtime/supabase-gateway-rpc.mjs'];

test('closed Docker context includes the catalogue imported by the application', async () => {
  const source = await readFile(new URL('lib/subrouter-catalogue-server.ts', root), 'utf8');
  const ignore = (await readFile(new URL('Dockerfile.railway.dockerignore', root), 'utf8')).split(/\r?\n/);
  assert.ok(source.includes('@/data/subrouter-catalogue.json'));
  assert.ok(ignore.includes('!data/subrouter-catalogue.json'));
});

test('closed Docker context and runtime contain the complete preparation import graph', async () => {
  const ignore = (await readFile(new URL('Dockerfile.railway.dockerignore', root), 'utf8')).split(/\r?\n/);
  const docker = await readFile(new URL('Dockerfile.railway', root), 'utf8');
  for (const module of modules) {
    const file = 'infra/railway/' + module;
    assert.ok(ignore.includes('!' + file), 'Missing build-context source: ' + file);
    assert.ok(docker.includes('COPY --from=build /app/' + file + ' ./' + file), 'Missing runtime source: ' + file);
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const imported = new URL(match[1], new URL(file, root)).href;
      assert.ok(modules.some(other => new URL('infra/railway/' + other, root).href === imported), 'Unreviewed runtime import: ' + match[1]);
    }
  }
  for (const excluded of ['**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.sqlite*', '**/*.db', '**/node_modules', '**/.git']) assert.ok(ignore.includes(excluded));
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

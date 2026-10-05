import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export async function inspectPreparation(root, io = fs) {
  const required = ['package.json', 'package-lock.json', 'data/models.json', 'vite.railway.config.ts'];
  const missing = [];
  for (const relative of required) {
    try { await io.access(path.join(root, relative)); }
    catch { missing.push(relative); }
  }
  if (missing.length) return {canBuildNodeArtifact: false, missing, productionReady: false};
  let manifest, lock;
  try {
    manifest = JSON.parse(await io.readFile(path.join(root, 'package.json'), 'utf8'));
    lock = JSON.parse(await io.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  } catch { return {canBuildNodeArtifact: false, reason: 'invalid_manifest_or_lock', productionReady: false}; }
  const declared = manifest.devDependencies?.vinext ?? manifest.dependencies?.vinext;
  const pinned = lock.packages?.['node_modules/vinext'];
  const lockedDeclaration = lock.packages?.['']?.devDependencies?.vinext ?? lock.packages?.['']?.dependencies?.vinext;
  if (declared !== '0.0.50' || lockedDeclaration !== declared || pinned?.version !== declared ||
      !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(pinned?.integrity || '')) {
    return {canBuildNodeArtifact: false, reason: 'pinned_vinext_lock_mismatch', productionReady: false};
  }
  return {canBuildNodeArtifact: true, productionReady: false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Preflight accepts no execution or install arguments.');
  const result = await inspectPreparation(fileURLToPath(new URL('../../', import.meta.url)));
  console.log(JSON.stringify(result));
  if (!result.canBuildNodeArtifact) process.exitCode = 78;
}

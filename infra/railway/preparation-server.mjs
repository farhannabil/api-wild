import {createOwnedBillingFromEnv} from './runtime/owned-billing.mjs';
import {createOwnedGatewayFromEnv} from './runtime/owned-gateway-assembly.mjs';
import {isGatewayHttp,isGatewayPath} from './runtime/gateway-http.mjs';
import {createServer, request as upstreamRequest} from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isStripeWebhookIngress, STRIPE_WEBHOOK_PATH} from './runtime/stripe-webhook-ingress.mjs';
import {isAaroUsageIngress,AARO_USAGE_PATH} from './runtime/aaro-usage-ingress.mjs';

import {createNativeAuthHttp,isNativeAuthHttp} from './runtime/native-auth-http.mjs';

const headers = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
});

const assetTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
});
const assetSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Vinext 0.0.50 indexes nested static paths with native separators on Windows.
// Snapshot only public client CSS/JS/media at boot, with slash URL keys on every
// OS. No request becomes a filesystem path, and no server, JSON or map is served.
export async function loadPublicAssets(clientDir) {
  if (!(await fs.lstat(clientDir)).isDirectory()) throw new Error('Invalid public asset directory.');
  const root = await fs.realpath(clientDir);
  const entries = new Map();
  let scanned = 0, bytes = 0;
  async function walk(directory, segments = []) {
    if (segments.length > 8) throw new Error('Public asset depth limit exceeded.');
    for (const item of await fs.readdir(directory, {withFileTypes: true})) {
      if (++scanned > 1024) throw new Error('Public asset entry limit exceeded.');
      if (!assetSegment.test(item.name)) continue;
      const parts = [...segments, item.name];
      const fullPath = path.join(directory, item.name);
      // Symlinks/junctions never join the public snapshot, including directories.
      const metadata = await fs.lstat(fullPath);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) { await walk(fullPath, parts); continue; }
      const type = assetTypes[path.extname(item.name)];
      if (!type || !metadata.isFile()) continue;
      if (await fs.realpath(fullPath) !== fullPath) throw new Error('Noncanonical public asset path.');
      const handle = await fs.open(fullPath, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) {
          throw new Error('Public asset byte limit exceeded.');
        }
        const body = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < body.length) {
          const {bytesRead} = await handle.read(body, offset, body.length - offset, offset);
          if (!bytesRead) throw new Error('Public asset changed during startup.');
          offset += bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) {
          throw new Error('Public asset changed during startup.');
        }
        bytes += body.length;
        entries.set('/' + parts.join('/'), {body, type});
      } finally { await handle.close(); }
    }
  }
  await walk(root);
  return Object.freeze({
    count: entries.size, bytes,
    lookup(url) {
      const pathname = url.split('?')[0];
      if (!pathname.startsWith('/') || !pathname.slice(1).split('/').every(part => assetSegment.test(part))) return;
      return entries.get(pathname);
    },
  });
}

// Read-only UI preview only. No environment flag can promote this scaffold to a
// customer-facing release; readiness and application service APIs stay closed.
export function preparationResponse({method = 'GET', url = '/', headers: incoming = {}} = {}) {
  if (Object.keys(incoming).some(name => name.toLowerCase().startsWith('oai-authenticated-'))) {
    return {status: 403, body: {error: 'Untrusted identity headers are not accepted.'}};
  }
  let pathname;
  try {
    if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || url.includes('#')) throw Error();
    pathname = new URL(url, 'http://preparation.invalid').pathname;
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    pathname = path.posix.normalize(pathname.replaceAll('\\', '/'));
    if (pathname.includes('\0')) throw Error();
  } catch { return {status: 400, body: {error: 'Invalid request path.'}}; }
  if (!['GET', 'HEAD'].includes(method) || incoming['transfer-encoding'] || Number(incoming['content-length'] || 0) > 0) {
    return {status: 503, body: {ready: false, phase: 'railway-preparation'}};
  }
  if (url === '/health/live') {
    return {status: 200, body: {alive: true, ready: false, phase: 'railway-preparation'}};
  }
  if (pathname !== '/health/ready' && !/^\/health(?:\/|$)/.test(pathname) &&
      !/^\/(?:api|v1)(?:\/|$)/.test(pathname) && pathname !== '/_vinext/image') return {action: 'proxy'};
  if (pathname === '/api/supabase-config' && url.split('?')[0] === pathname) return {action: 'proxy'};
  return {status: 503, body: {
    ready: false, phase: 'railway-preparation',
    required: ['verified-source', 'postgres-port-and-migration', 'customer-acceptance',
      'stripe-credit-refund-acceptance', 'provider-response-debit-acceptance'],
  }};
}

export function proxyHeaders(incoming, origin = 'https://apiwild.com') {
  const result = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (key.startsWith('oai-authenticated-') || ['authorization', 'cookie', 'host', 'forwarded',
      'x-forwarded-host', 'x-forwarded-proto', 'connection', 'upgrade', 'proxy-authorization',
      'transfer-encoding', 'content-length', 'te', 'trailer'].includes(key)) continue;
    result[key] = value;
  }
  result.host = new URL(origin).host;
  return result;
}

export function createPreparationServer({backendPort, origin = 'https://apiwild.com', publicAssets, stripeWebhookIngress, aaroUsageIngress, nativeAuthHttp, gatewayHttp, ownedBilling} = {}) {
  if (stripeWebhookIngress !== undefined && !isStripeWebhookIngress(stripeWebhookIngress)) {
    throw new Error('Invalid Stripe webhook injection.');
  }
  if (aaroUsageIngress !== undefined && !isAaroUsageIngress(aaroUsageIngress)) throw new Error('Invalid AARO usage injection.');
  if (nativeAuthHttp !== undefined && !isNativeAuthHttp(nativeAuthHttp)) throw new Error('Invalid native auth injection.');
  if(gatewayHttp!==undefined&&!isGatewayHttp(gatewayHttp))throw new Error('Invalid gateway injection.');
  return createServer({requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 16384}, (request, response) => {
    // Explicit owner-lane server configuration only; no env flag/default CLI
    // enables this route. All other application/release gates remain closed.
    if(ownedBilling?.matches(request.url)){void ownedBilling.handle(request,response);return;}
    if (stripeWebhookIngress && request.url === STRIPE_WEBHOOK_PATH) {
      void stripeWebhookIngress.handle(request, response); return;
    }
    if (aaroUsageIngress && request.url === AARO_USAGE_PATH) {
      void aaroUsageIngress.handle(request, response); return;
    }
    if(gatewayHttp&&isGatewayPath(request.url)){void gatewayHttp.handle(request,response);return;}
    if (nativeAuthHttp && (request.url?.startsWith('/api/native/auth/')||request.url?.startsWith('/api/native/customer/')||request.url==='/v1/chat/completions')) {
      void nativeAuthHttp.handle(request, response); return;
    }
    const result = preparationResponse(request);
    const asset = result.action === 'proxy' ? publicAssets?.lookup(request.url) : undefined;
    if (asset) {
      response.writeHead(200, {...headers, 'Content-Type': asset.type, 'Content-Length': asset.body.length});
      response.end(request.method === 'HEAD' ? undefined : asset.body);
      request.resume(); return;
    }
    if (result.action === 'proxy' && Number.isInteger(backendPort) && backendPort > 0 && backendPort <= 65535) {
      const upstream = upstreamRequest({hostname: '127.0.0.1', port: backendPort, method: request.method,
        path: request.url, headers: proxyHeaders(request.headers, origin), timeout: 30000}, received => {
        response.writeHead(received.statusCode || 502, {...received.headers, 'cache-control': 'no-store'});
        received.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(503, headers);
        response.end(JSON.stringify({ready: false, error: 'UI preview unavailable.'}));
      });
      request.on('aborted', () => upstream.destroy());
      upstream.end(); request.resume(); return;
    }
    if (result.action === 'proxy') {
      result.status = 503; result.body = {ready: false, error: 'UI artifact unavailable.'};
    }
    response.writeHead(result.status, headers);
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(result.body));
    request.resume(); // Discard bodies without retaining customer data.
  });
}

// Local previews never bind to the LAN or relax application readiness. Railway's
// existing listener is unchanged; an explicit --local selects loopback only.
export function preparationListenOptions(args = [], source = {}) {
  if (!Array.isArray(args) || (args.length && (args.length !== 1 || args[0] !== '--local'))) {
    throw new Error('Invalid preparation server arguments.');
  }
  const local = args.length === 1;
  if (source.PORT !== undefined && typeof source.PORT !== 'string') {
    throw new Error('Invalid preparation server port.');
  }
  const rawPort = source.PORT || (local ? '4318' : '3000');
  if (typeof rawPort !== 'string' || !/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65535) {
    throw new Error('Invalid preparation server port.');
  }
  return Object.freeze({port: Number(rawPort), host: local ? '127.0.0.1' : '0.0.0.0', local});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const listener = preparationListenOptions(process.argv.slice(2), {PORT: process.env.PORT});
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'node_modules/vinext/package.json'), 'utf8'));
  if (manifest.version !== '0.0.50') throw new Error('Unverified Vinext runtime version.');
  await fs.access(path.join(root, 'dist/server/index.js'));
  const publicAssets = await loadPublicAssets(path.join(root, 'dist/client'));
  const {startProdServer} = await import('vinext/server/prod-server');
  const backend = await startProdServer({port: 0, host: '127.0.0.1', outDir: path.join(root, 'dist')});
  for(const name of ['NATIVE_AUTH_ENABLED','NATIVE_CUSTOMER_ENABLED','NATIVE_KEY_WRITES_ENABLED','NATIVE_CHECKOUT_ENABLED','NATIVE_RELAY_ENABLED'])if(process.env[name]!==undefined&&!['true','false'].includes(process.env[name]))throw new Error('Invalid native enablement.');
  const allowedModels=process.env.NATIVE_RELAY_ENABLED==='true'?JSON.parse(await fs.readFile(path.join(root,'data/selected-supplier-models.json'),'utf8')).models.map(model=>model.model_name):[];
  const nativeAuthHttp = createNativeAuthHttp({enabled:process.env.NATIVE_AUTH_ENABLED==='true',customerOperationsEnabled:process.env.NATIVE_CUSTOMER_ENABLED==='true',keyWritesEnabled:process.env.NATIVE_KEY_WRITES_ENABLED==='true',nativeCheckoutEnabled:process.env.NATIVE_CHECKOUT_ENABLED==='true',relayEnabled:process.env.NATIVE_RELAY_ENABLED==='true',allowedModels});
  const gatewayHttp=createOwnedGatewayFromEnv({env:process.env,catalog:process.env.APIWILD_OWNED_GATEWAY_ENABLED==='true'?JSON.parse(await fs.readFile(path.join(root,'data/selected-supplier-models.json'),'utf8')):{models:[]}});
  const ownedBilling=await createOwnedBillingFromEnv(process.env);
  const frontend = createPreparationServer({backendPort: backend.port, publicAssets, nativeAuthHttp, gatewayHttp, ownedBilling});
  frontend.once('error', () => backend.server.close());
  frontend.listen(listener.port, listener.host, () => {
    console.log(`Guarded ${listener.local ? 'local' : 'Railway'} UI preparation listening; readiness remains closed.`);
  });
}

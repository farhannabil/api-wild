// Read-only operational liveness and launch acceptance. This module never receives credentials or calls a
// provider. Configuration is reported separately from customer acceptance.
const instances = new WeakSet();
export const isLaunchStatusHttp = value => instances.has(value);
const paths = new Set(['/health/live', '/health/ready']);
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const remainingAcceptance = Object.freeze([
  'customer-session-acceptance', 'payment-lifecycle-acceptance',
  'supplier-budget-acceptance', 'supplier-debit-acceptance',
]);
export function createLaunchStatusHttp({sourceCommit, accountConfigured = false, billingConfigured = false, inferenceConfigured = false, checkoutEnabled = false} = {}) {
  const source = /^[a-f0-9]{40}$/.test(sourceCommit ?? '') ? sourceCommit : null;
  const checks = {
    sourceCommit: source,
    accountConfiguration: accountConfigured ? 'configured' : 'missing',
    billingConfiguration: billingConfigured ? 'configured' : 'missing',
    inferenceConfiguration: inferenceConfigured ? 'configured' : 'disabled',
    checkoutEnabled: billingConfigured && checkoutEnabled === true,
    acceptance: 'not-recorded',
  };
  // An enable flag is not acceptance evidence. These gates are removed only in
  // a reviewed release carrying the actual end-to-end acceptance results.
  const blockers = [...remainingAcceptance,
    ...(!accountConfigured ? ['account-configuration'] : []),
    ...(!billingConfigured ? ['billing-configuration'] : []),
    ...(!inferenceConfigured ? ['inference-disabled'] : []),
    ...(!(billingConfigured && checkoutEnabled) ? ['checkout-disabled'] : []),
  ];
  const readiness = JSON.stringify({ready:false,phase:'launch-preparation',blockers,checks});
  const liveness = JSON.stringify({alive:true,ready:false,phase:'launch-preparation',sourceCommit:source});
  const adapter = Object.freeze({
    matches: path => paths.has(path),
    handle(req, res) {
      let status = req.url === '/health/ready' ? 503 : 200;
      let body = req.url === '/health/live' ? liveness : readiness;
      if (!paths.has(req.url)) { status = 404; body = JSON.stringify({error:'Not found.'}); }
      else if (Object.keys(req.headers).some(name => name.toLowerCase().startsWith('oai-authenticated-'))) {status=403;body=JSON.stringify({error:'Untrusted identity headers.'});}
      else if (!['GET','HEAD'].includes(req.method) || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) {status=405;body=JSON.stringify({error:'Read-only endpoint.'});}
      res.writeHead(status, headers);res.end(req.method === 'HEAD' ? undefined : body);req.resume();
    },
  });
  instances.add(adapter);
  return adapter;
}

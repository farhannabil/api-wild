// Read-only operational liveness and launch acceptance. This module never receives credentials or calls a
// provider. Configuration is reported separately from customer acceptance.
import {acceptanceGates,releaseAcceptanceState} from './release-acceptance.mjs';
const instances = new WeakSet();
export const isLaunchStatusHttp = value => instances.has(value);
const paths = new Set(['/health/live', '/health/ready']);
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
export function createLaunchStatusHttp({sourceCommit, accountConfigured = false, billingConfigured = false, inferenceConfigured = false, checkoutEnabled = false,
  acceptance,version,configuredModels=[],conversion,billingMode,checkoutBillingMode,sweepEnabled=false,availableModels=()=>[],clock=Date.now} = {}) {
  const source = /^[a-f0-9]{40}$/.test(sourceCommit ?? '') ? sourceCommit : null;
  const configuration = {
    sourceCommit: source,
    accountConfiguration: accountConfigured ? 'configured' : 'missing',
    billingConfiguration: billingConfigured ? 'configured' : 'missing',
    inferenceConfiguration: inferenceConfigured ? 'configured' : 'disabled',
    checkoutEnabled: billingConfigured && checkoutEnabled === true,
  };
  // An enable flag is not acceptance evidence. These gates are removed only in
  // a reviewed release carrying the actual end-to-end acceptance results.
  const configurationBlockers = [
    ...(!source ? ['source-unverified'] : []),
    ...(!accountConfigured ? ['account-configuration'] : []),
    ...(!billingConfigured ? ['billing-configuration'] : []),
    ...(!inferenceConfigured ? ['inference-disabled'] : []),
    ...(!(billingConfigured && checkoutEnabled) ? ['checkout-disabled'] : []),
  ];
  const adapter = Object.freeze({
    matches: path => paths.has(path),
    handle(req, res) {
      let accepted=null;try{accepted=releaseAcceptanceState(acceptance,{version,configuredModels,conversion,billingMode,checkoutBillingMode,sweepEnabled,availableModels:availableModels(),now:clock()});}catch{}
      const blockers=[...(!accepted?acceptanceGates:[]),...configurationBlockers];
      const ready=blockers.length===0,phase=ready?'launched':'launch-preparation';
      const checks={...configuration,acceptance:accepted?'recorded':'not-recorded',acceptedModelCount:accepted?.modelCount??0,acceptanceValidUntil:accepted?.validUntil??null};
      let status = req.url === '/health/ready' ? (ready?200:503) : 200;
      let body = JSON.stringify(req.url === '/health/live'?{alive:true,ready,phase,sourceCommit:source}:{ready,phase,blockers,checks});
      if (!paths.has(req.url)) { status = 404; body = JSON.stringify({error:'Not found.'}); }
      else if (Object.keys(req.headers).some(name => name.toLowerCase().startsWith('oai-authenticated-'))) {status=403;body=JSON.stringify({error:'Untrusted identity headers.'});}
      else if (!['GET','HEAD'].includes(req.method) || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) {status=405;body=JSON.stringify({error:'Read-only endpoint.'});}
      res.writeHead(status, headers);res.end(req.method === 'HEAD' ? undefined : body);req.resume();
    },
  });
  instances.add(adapter);
  return adapter;
}

// Optional unpaid startup observation. No credentials, model dispatch, financial
// writes, public endpoint, retry, or change to customer readiness/startup.
import {createSupplierConversionGuard} from './subrouter-supplier-conversion.mjs';

export function createSupplierStartupProbeFromEnv({env={},fetchImpl=fetch,clock=Date.now,write=()=>{}}={}){
  const enabled=env.APIWILD_SUPPLIER_STARTUP_PROBE_ENABLED==='true';
  const sourceCommit=/^[a-f0-9]{40}$/.test(env.RAILWAY_GIT_COMMIT_SHA??'')?env.RAILWAY_GIT_COMMIT_SHA:null;
  const conversionJson=enabled?env.APIWILD_SUPPLIER_CONVERSION_JSON:undefined;
  let pending;
  return Object.freeze({enabled,start(){
    // Preserve one promise/result even if a caller starts this observer twice.
    if(pending)return pending;
    if(!enabled)return pending=Promise.resolve(Object.freeze({enabled:false}));
    pending=(async()=>{
      let status='FAIL';
      try{
        const guard=createSupplierConversionGuard({conversion:JSON.parse(conversionJson),fetchImpl,clock,timeoutMs:5000});
        await guard.assertConversion();status='PASS';
      }catch{/* Never print an upstream response, exception, environment or secret. */}
      const result=Object.freeze({supplierStartupProbe:status,sourceCommit,unpaid:true});
      try{write(result);}catch{/* Observation/logging must never interrupt customer startup. */}
      return result;
    })();
    return pending;
  }});
}

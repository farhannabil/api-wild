// Explicit one-order operator assembly. It has no public HTTP route, timer or
// credentials lookup beyond its injected environment. --check makes no requests.
import {SUPABASE_ORIGIN,strictObject,withDeadline} from './supabase-gateway-rpc.mjs';
import {createSubrouterSaasActivation} from './subrouter-saas-activation.mjs';
import {createSupplierAllowanceWorker} from './supplier-allowance-worker.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operations=Object.freeze({
  apiwild_allowance_claim:['p_owner','p_order'],
  apiwild_allowance_dispatch_guard:['p_owner','p_order','p_version'],
  apiwild_allowance_finish:['p_owner','p_order','p_version','p_receipt'],
  apiwild_allowance_uncertain:['p_owner','p_order','p_version'],
});
const required=['SUPABASE_SECRET_KEY','SUBROUTER_SAAS_ACTIVATION_TOKEN','APIWILD_NATIVE_CODE_REFERENCE','APIWILD_NATIVE_REDEMPTION_CODE'];
const unavailable=()=>Object.assign(new Error('Allowance operator unavailable.'),{code:'allowance_operator_unavailable'});
function key(value){
  if(typeof value!=='string'||value.length>8192)throw unavailable();
  if(/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(value))return {value,legacy:false};
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))throw unavailable();
  let claims;try{claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));}catch{throw unavailable();}
  if(claims?.role!=='service_role'||claims?.ref!=='yautmilnpllojugpmfgy')throw unavailable();
  return {value,legacy:true}; // Shape only; Supabase authenticates it.
}
function configuration(env){
  const secret=key(env.SUPABASE_SECRET_KEY),token=env.SUBROUTER_SAAS_ACTIVATION_TOKEN;
  if(typeof token!=='string'||token.length<16||token.length>8192||/[\x00-\x20\x7f]/.test(token)
      ||!UUID.test(env.APIWILD_NATIVE_CODE_REFERENCE)||typeof env.APIWILD_NATIVE_REDEMPTION_CODE!=='string'
      ||!/^[A-Za-z0-9-]{4,128}$/.test(env.APIWILD_NATIVE_REDEMPTION_CODE))throw unavailable();
  return {secret,token,codeReference:env.APIWILD_NATIVE_CODE_REFERENCE,code:env.APIWILD_NATIVE_REDEMPTION_CODE};
}
function createRpc({secret,fetchImpl}){
  return async(name,raw,{signal:parent}={})=>{
    if(!Object.hasOwn(operations,name))throw unavailable();
    strictObject(raw,operations[name]);if(operations[name].some(field=>!Object.hasOwn(raw,field)))throw unavailable();
    const body=JSON.stringify(raw);if(Buffer.byteLength(body)>4096)throw unavailable();
    return withDeadline(async deadline=>{
      const signal=parent?AbortSignal.any([parent,deadline]):deadline;
      if(signal.aborted)throw unavailable();
      let response,reader;
      const cancel=()=>{try{void (reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}catch{}};
      signal.addEventListener('abort',cancel,{once:true});
      try{
        const url=SUPABASE_ORIGIN+'/rest/v1/rpc/'+name;
        response=await fetchImpl(url,{method:'POST',redirect:'error',cache:'no-store',signal,
          headers:{apikey:secret.value,...(secret.legacy?{authorization:'Bearer '+secret.value}:{}),
            'content-type':'application/json',accept:'application/json','content-profile':'public'},body});
        if(signal.aborted||!(response instanceof Response)||!response.ok||response.redirected||(response.url&&response.url!==url)
            ||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw unavailable();
        const length=response.headers.get('content-length');
        if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))throw unavailable();
        reader=response.body?.getReader();if(!reader)throw unavailable();
        const chunks=[];let size=0;
        for(;;){const {done,value}=await reader.read();if(signal.aborted)throw unavailable();if(done)break;
          if(!(value instanceof Uint8Array)||(size+=value.length)>8192||chunks.length>=1024)throw unavailable();chunks.push(value);}
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
      }finally{signal.removeEventListener('abort',cancel);cancel();try{reader?.releaseLock();}catch{}}
    },8000);
  };
}
export async function runAllowanceOperator({argv=[],env={},fetchImpl=fetch,write=()=>{}}={}){
  // No arbitrary SQL, RPC names, payment facts, hosts, credentials or native
  // user/package/quota values can be supplied through command-line arguments.
  if(!argv.length){write({usage:'--check|--execute --owner MODE:supabase:UUID --order UUID',networkRequests:false});return 0;}
  try{
    if(argv.length!==5||!['--check','--execute'].includes(argv[0])||argv[1]!=='--owner'||argv[3]!=='--order'
        ||!/^(live|test):supabase:[0-9a-f-]{36}$/.test(argv[2])||!UUID.test(argv[2].split(':')[2])||!UUID.test(argv[4]))throw unavailable();
    const missing=required.filter(name=>!env[name]);
    if(missing.length){write({configured:false,missing,networkRequests:false});return 3;}
    const config=configuration(env);
    if(argv[0]==='--check'){
      write({configured:true,enabled:env.APIWILD_ALLOWANCE_WORKER_ENABLED==='true',databaseAndMappingVerified:false,networkRequests:false});return 0;
    }
    if(env.APIWILD_ALLOWANCE_WORKER_ENABLED!=='true'){
      write({activated:false,status:'disabled',networkRequests:false});return 3;
    }
    const worker=createSupplierAllowanceWorker({enabled:true,timeoutMs:30000,rpc:createRpc({secret:config.secret,fetchImpl}),
      resolveCode:async reference=>{if(reference!==config.codeReference)throw unavailable();return config.code;},
      activate:createSubrouterSaasActivation({enabled:true,token:config.token,fetchImpl,timeoutMs:10000})});
    const result=await worker.run({owner:argv[2],orderId:argv[4]});write(result);return result.activated===true?0:2;
  }catch{write({activated:false,status:'unavailable',automaticRetry:false});return 3;}
}

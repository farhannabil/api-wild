// Nonpublic, one-owner/request reconciliation. No enumeration, inference, retry,
// SQL execution, customer credit mutation or caller-supplied accounting facts.
import {SUPABASE_ORIGIN,strictObject,withDeadline} from './supabase-gateway-rpc.mjs';
import {createSubrouterReceiptReader} from './subrouter-receipt-reader.mjs';
import {createSupplierDebitReconciler} from './supplier-debit-reconciliation.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=()=>Error('supplier_operator_unavailable');
const operations={apiwild_supplier_request_read:['p_owner','p_request'],apiwild_supplier_debit_apply:['p_owner','p_request','p_fact','p_digest']};
export function createSupplierDebitRpc({secretKey,fetchImpl=fetch}){
 let legacy=false;
 if(typeof secretKey!=='string'||secretKey.length>8192)throw fail();
 if(!/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(secretKey)){
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secretKey))throw fail();
  let claims;try{claims=JSON.parse(Buffer.from(secretKey.split('.')[1],'base64url').toString('utf8'));}catch{throw fail();}
  if(claims?.role!=='service_role'||claims?.ref!=='yautmilnpllojugpmfgy')throw fail();legacy=true;
 }
 return async(name,raw,{signal:parent}={})=>{
  if(!Object.hasOwn(operations,name))throw fail();strictObject(raw,operations[name]);
  if(operations[name].some(k=>!Object.hasOwn(raw,k))||typeof raw.p_owner!=='string'||!/^(live|test):supabase:[0-9a-f-]{36}$/.test(raw.p_owner)
   ||!UUID.test(raw.p_owner.split(':')[2])||!UUID.test(raw.p_request))throw fail();
  const body=JSON.stringify(raw);if(Buffer.byteLength(body)>8192)throw fail();
  return withDeadline(async deadline=>{
   const signal=parent?AbortSignal.any([parent,deadline]):deadline;let response,reader;
   const cancel=()=>{try{void (reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}catch{}};signal.addEventListener('abort',cancel,{once:true});
   try{
    if(signal.aborted)throw fail();const url=SUPABASE_ORIGIN+'/rest/v1/rpc/'+name;
    response=await fetchImpl(url,{method:'POST',redirect:'error',cache:'no-store',signal,headers:{apikey:secretKey,...(legacy?{authorization:'Bearer '+secretKey}:{}),'content-type':'application/json',accept:'application/json','content-profile':'public'},body});
    if(signal.aborted||!(response instanceof Response)||!response.ok||response.redirected||(response.url&&response.url!==url)
     ||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw fail();
    const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))throw fail();
    reader=response.body?.getReader();if(!reader)throw fail();let size=0;const chunks=[];
    for(;;){const {done,value}=await reader.read();if(signal.aborted)throw fail();if(done)break;if(!(value instanceof Uint8Array)||(size+=value.length)>8192||chunks.length>=1024)throw fail();chunks.push(value);}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
   }finally{signal.removeEventListener('abort',cancel);cancel();try{reader?.releaseLock();}catch{}}
  },8000);
 };
}
export async function runSupplierDebitOperator({argv=[],env={},fetchImpl=fetch,clock=Date.now,write=()=>{}}={}){
 if(!argv.length){write({usage:'--check|--execute --owner MODE:supabase:UUID --request UUID',networkRequests:false});return 0;}
 try{
  if(argv.length!==5||!['--check','--execute'].includes(argv[0])||argv[1]!=='--owner'||argv[3]!=='--request'
   ||!/^(live|test):supabase:[0-9a-f-]{36}$/.test(argv[2])||!UUID.test(argv[2].split(':')[2])||!UUID.test(argv[4]))throw fail();
  const required=['SUPABASE_SECRET_KEY','SUBROUTER_ACCOUNT_ACCESS_TOKEN','SUBROUTER_ACCOUNT_USER_ID','APIWILD_SUPPLIER_BINDINGS_JSON','APIWILD_SUPPLIER_CONVERSION_JSON'];
  const missing=required.filter(k=>!env[k]);if(missing.length){write({configured:false,missing,networkRequests:false});return 3;}
  if(!/^[1-9][0-9]{0,15}$/.test(env.SUBROUTER_ACCOUNT_USER_ID))throw fail();
  const rpc=createSupplierDebitRpc({secretKey:env.SUPABASE_SECRET_KEY,fetchImpl});
  const reader=createSubrouterReceiptReader({enabled:true,accessToken:env.SUBROUTER_ACCOUNT_ACCESS_TOKEN,accountUserId:Number(env.SUBROUTER_ACCOUNT_USER_ID),
   bindings:JSON.parse(env.APIWILD_SUPPLIER_BINDINGS_JSON),conversion:JSON.parse(env.APIWILD_SUPPLIER_CONVERSION_JSON),fetchImpl,clock});
  const enabled=env.APIWILD_SUPPLIER_DEBIT_ENABLED==='true';
  if(argv[0]==='--check'){write({configured:true,enabled,databaseAndReceiptVerified:false,networkRequests:false});return 0;}
  if(!enabled){write({reconciled:false,status:'disabled',networkRequests:false});return 3;}
  const reconciler=createSupplierDebitReconciler({enabled:true,timeoutMs:30000,rpc,readReceipt:reader.readReceipt,
   readRequest:({owner,requestId},options)=>rpc('apiwild_supplier_request_read',{p_owner:owner,p_request:requestId},options)});
  const result=await reconciler.reconcile({owner:argv[2],requestId:argv[4]});write(result);return result.reconciled?0:2;
 }catch{write({reconciled:false,held:true,status:'unavailable',automaticRetry:false});return 3;}
}

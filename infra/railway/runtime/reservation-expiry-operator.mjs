// Nonpublic, one explicit request only. SQL owns expiry/state/CAS authority.
// No enumeration, scheduler, supplier call, receipt fabrication or hold release.
import {SUPABASE_ORIGIN,strictObject,exactInteger,withDeadline} from './supabase-gateway-rpc.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable=()=>Error('Reservation expiry unavailable.');
const url=SUPABASE_ORIGIN+'/rest/v1/rpc/apiwild_gateway_expire';
function secret(value){
 if(typeof value!=='string'||value.length>8192)throw unavailable();
 if(/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(value))return {value,legacy:false};
 if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))throw unavailable();
 let claims;try{claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));}catch{throw unavailable();}
 if(claims?.role!=='service_role'||claims?.ref!=='yautmilnpllojugpmfgy')throw unavailable();
 return {value,legacy:true}; // Shape only: the fixed Supabase project authenticates.
}
async function expire({owner,id,version,key,fetchImpl,timeoutMs}){
 return withDeadline(async signal=>{
  let response,reader;const cancel=()=>{try{void (reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}catch{}};
  signal.addEventListener('abort',cancel,{once:true});
  try{
   response=await fetchImpl(url,{method:'POST',redirect:'error',cache:'no-store',signal,
    headers:{apikey:key.value,...(key.legacy?{authorization:'Bearer '+key.value}:{}),'content-type':'application/json',accept:'application/json','content-profile':'public'},
    body:JSON.stringify({p_owner:owner,p_id:id,p_expected_version:version})});
   if(signal.aborted||!(response instanceof Response)||!response.ok||response.redirected||(response.url&&response.url!==url)
    ||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw unavailable();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))throw unavailable();
   reader=response.body?.getReader();if(!reader)throw unavailable();const chunks=[];let size=0;
   for(;;){const {done,value}=await reader.read();if(signal.aborted)throw unavailable();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.length)>8192||chunks.length>=1024)throw unavailable();chunks.push(value);}
   const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
   strictObject(result,['cancelled','record']);if(typeof result.cancelled!=='boolean')throw unavailable();
   const r=result.record;
   if(!r||r.id!==id||r.user_id!==owner||!['reserved','executing','uncertain','succeeded','failed','cancelled'].includes(r.state)
    ||typeof r.supplier_pending!=='boolean')throw unavailable();
   exactInteger(r.version);for(const field of ['cost_usd_micros','cost_cny_micros','observed_cny_micros'])exactInteger(r[field]);
   if(result.cancelled){
    if(r.state!=='cancelled'||r.version!==version+1||r.supplier_pending||r.cost_usd_micros!==0||r.cost_cny_micros!==0
     ||r.observed_cny_micros!==0||r.pricing_bound_exceeded!==false)throw unavailable();
    return {cancelled:true,status:'expired-never-dispatched',automaticRetry:false};
   }
   const held=r.supplier_pending||['executing','uncertain'].includes(r.state);
   return {cancelled:false,status:held?'held-for-reconciliation':'unchanged',automaticRetry:false};
  }finally{signal.removeEventListener('abort',cancel);cancel();try{reader?.releaseLock();}catch{}}
 },timeoutMs);
}
export async function runReservationExpiryOperator({argv=[],env={},fetchImpl=fetch,write=()=>{},timeoutMs=8000}={}){
 if(!argv.length){write({usage:'--check|--execute --owner MODE:supabase:UUID --request UUID --version INTEGER',networkRequests:false});return 0;}
 try{
  if(argv.length!==7||!['--check','--execute'].includes(argv[0])||argv[1]!=='--owner'||argv[3]!=='--request'||argv[5]!=='--version'
   ||!/^(live|test):supabase:[0-9a-f-]{36}$/.test(argv[2])||!UUID.test(argv[2].split(':')[2])||!UUID.test(argv[4])
   ||!/^(0|[1-9][0-9]{0,15})$/.test(argv[6]))throw unavailable();
  const version=exactInteger(Number(argv[6]),0,Number.MAX_SAFE_INTEGER-1);exactInteger(timeoutMs,1,10000);
  if(!env.SUPABASE_SECRET_KEY){write({configured:false,missing:['SUPABASE_SECRET_KEY'],networkRequests:false});return 3;}
  const key=secret(env.SUPABASE_SECRET_KEY),enabled=env.APIWILD_RESERVATION_EXPIRY_ENABLED==='true';
  if(argv[0]==='--check'){write({configured:true,enabled,databaseAndRequestVerified:false,networkRequests:false});return 0;}
  if(!enabled){write({cancelled:false,status:'disabled',networkRequests:false});return 3;}
  const result=await expire({owner:argv[2],id:argv[4],version,key,fetchImpl,timeoutMs});write(result);return result.cancelled?0:2;
 }catch{write({cancelled:false,status:'unconfirmed',automaticRetry:false});return 3;}
}

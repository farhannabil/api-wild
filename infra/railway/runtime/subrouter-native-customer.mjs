// Server-only READ adapter for the official dist frontend contract at commit
// 5303cd51c76eafed528b4e9032d77fdfcacc45b9. No login, writes, keys or credit issued.
export const NATIVE_STATION_ORIGIN='https://apiwild.subrouter.ai';
export class NativeCustomerError extends Error {constructor(code,status=503){super(code);this.name='NativeCustomerError';this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new NativeCustomerError(code,status);};
const clean=(value,fields)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail('native_invalid_response');return Object.fromEntries(fields.filter(field=>Object.hasOwn(value,field)&&(value[field]===null||['string','boolean'].includes(typeof value[field])||typeof value[field]==='number'&&Number.isFinite(value[field]))).map(field=>[field,value[field]]));};
const cancel=body=>{try{Promise.resolve(body?.cancel()).catch(()=>{});}catch{}};
export function createNativeCustomerReader(config={}){
 if(config.enabled!==undefined&&typeof config.enabled!=='boolean')fail('native_invalid_configuration');
 if(config.enabled!==true)return Object.freeze({async read(){fail('native_customer_disabled');}});
 const {userId,sessionCookie}=config;
 if(config.stationOrigin!==NATIVE_STATION_ORIGIN||!Number.isSafeInteger(userId)||userId<1||typeof sessionCookie!=='string'||!sessionCookie.length||sessionCookie.length>8192||/[\r\n\x00-\x1f\x7f]/.test(sessionCookie))fail('native_invalid_configuration');
 const fetchImpl=config.fetchImpl??fetch;if(typeof fetchImpl!=='function')fail('native_invalid_configuration');
 async function get(path){
  const controller=new AbortController();let timer,response,reader;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel(reader??response?.body);reject(new NativeCustomerError('native_request_timeout'));},10000);});
  const work=(async()=>{
   response=await fetchImpl(NATIVE_STATION_ORIGIN+path,{method:'GET',headers:{cookie:sessionCookie,'New-Api-User':String(userId),accept:'application/json'},redirect:'error',cache:'no-store',signal:controller.signal});
   if(controller.signal.aborted||!(response instanceof Response)||response.redirected||(response.url&&response.url!==NATIVE_STATION_ORIGIN+path))fail('native_invalid_response');
   if(!response.ok)fail(response.status===401?'native_session_expired':'native_request_failed',response.status===401?401:503);
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))fail('native_invalid_response');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>524288))fail('native_response_too_large');
   reader=response.body?.getReader();if(!reader)fail('native_invalid_response');let bytes=0;const chunks=[];
   while(true){const {value,done}=await reader.read();if(controller.signal.aborted)fail('native_request_timeout');if(done)break;if(!(value instanceof Uint8Array)||(bytes+=value.byteLength)>524288||chunks.length>=4096)fail('native_response_too_large');chunks.push(value);}
   const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
   if(!body||body.success!==true||!Object.hasOwn(body,'data'))fail('native_request_failed');return body.data;
  })();
  try{return await Promise.race([work,deadline]);}catch(e){if(e instanceof NativeCustomerError)throw e;fail('native_request_failed');}
  finally{clearTimeout(timer);controller.abort();cancel(reader??response?.body);try{reader?.releaseLock();}catch{}}
 }
 async function identity(){const self=await get('/api/dist/user/self');if(!self||self.id!==userId)fail('native_owner_mismatch',403);return clean(self,['id','username','quota','used_quota','request_count','group','status']);}
 return Object.freeze({async read(operation){
  if(!['account','usage','keys','models','pricing','logs','logStats'].includes(operation))fail('native_operation_not_allowed',400);
  const self=await identity();if(operation==='account')return Object.freeze({authority:'subrouter-native-station',quotaUnitsPerUsd:500000,account:self});
  const paths={usage:'/api/dist/user/usage',keys:'/api/dist/token/list',models:'/api/dist/site/models',pricing:'/api/dist/site/pricing',logs:'/api/dist/user/logs?p=1&page_size=20',logStats:'/api/dist/user/logs/stat'};
  const data=await get(paths[operation]);
  if(operation==='keys'){
   if(!Array.isArray(data))fail('native_invalid_response');
   return data.map(row=>clean(row,['id','name','status','created_time','accessed_time','expired_time','remain_quota','used_quota','unlimited_quota','model_limits_enabled','model_limits']));
  }
  if(operation==='logs'){
   if(!data||!Array.isArray(data.items))fail('native_invalid_response');
   return {authority:'subrouter-native-station',items:data.items.map(row=>clean(row,['id','created_at','type','model_name','prompt_tokens','completion_tokens','quota','request_id','upstream_request_id','use_time','is_stream','token_name'])),total:data.total};
  }
  if(operation==='usage')return {authority:'subrouter-native-station',data:clean(data,['quota','used_quota','request_count','package_used_quota'])};
  if(operation==='logStats')return {authority:'subrouter-native-station',data:clean(data,['quota','rpm','tpm','token'])};
  // Remaining data is server-only native JSON, not a browser DTO or financial
  // conversion. Caller must apply its endpoint's safe presentation projection.
  return Object.freeze({authority:'subrouter-native-station',operation,data});
 }});
}

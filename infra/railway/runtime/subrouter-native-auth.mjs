// Native auth BFF port. Official Sub-Router frontend commit 5303cd51.
// Store implementations are server-only; no station session reaches the browser.
import {randomBytes,createHash} from 'node:crypto';
import {NATIVE_STATION_ORIGIN,NativeCustomerError,createNativeCustomerReader} from './subrouter-native-customer.mjs';
export const NATIVE_AUTH_PREFIX='/api/native/auth';
const COOKIE='__Host-apiwild_native',CUSTOMER_ORIGIN='https://apiwild.com';
const fail=(code,status=503)=>{throw new NativeCustomerError(code,status);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const cancel=body=>{try{Promise.resolve(body?.cancel()).catch(()=>{});}catch{}};
const project=user=>Object.fromEntries(['id','username','quota','used_quota','status','group'].filter(k=>Object.hasOwn(user,k)&&['string','number','boolean'].includes(typeof user[k])).map(k=>[k,user[k]]));
function object(value,fields){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))fail('native_invalid_request',400);return value;}
function handleCookie(header){
 const matches=(header||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
 if(matches.length!==1)return null;const token=matches[0].slice(COOKIE.length+1);return /^[a-f0-9]{64}$/.test(token)?token:null;
}
function upstreamCookies(headers){
 const values=headers.getSetCookie();const pairs=[];
 for(const value of values){
  const pair=value.split(';',1)[0];
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(pair)||pair.length>4096)fail('native_invalid_session');
  // A successful login must supply a live cookie. Expired deletion cookies do
  // not qualify as authentication; actual names are learned from the response.
  if(/;\s*max-age\s*=\s*(?:0|-\d+)/i.test(value))continue;
  pairs.push(pair);
 }
 if(!pairs.length||pairs.join('; ').length>8192)fail('native_invalid_session');return pairs.join('; ');
}
export function createNativeAuth(config={}){
 if(config.enabled!==undefined&&typeof config.enabled!=='boolean')fail('native_invalid_configuration');
 const enabled=config.enabled===true,store=config.sessionStore,fetchImpl=config.fetchImpl??fetch,now=config.now??Date.now;
 if(enabled&&(config.stationOrigin!==NATIVE_STATION_ORIGIN||config.customerOrigin!==CUSTOMER_ORIGIN||!store||!['get','put','delete'].every(k=>typeof store[k]==='function')||typeof fetchImpl!=='function'||typeof now!=='function'))fail('native_invalid_configuration');
 async function transport(path,{method='GET',body,session}={}){
  const controller=new AbortController();let timer,response,reader;
  const deadline=new Promise((_,reject)=>timer=setTimeout(()=>{controller.abort();cancel(reader??response?.body);reject(new NativeCustomerError('native_request_timeout'));},10000));
  const work=(async()=>{
   const headers={accept:'application/json'};if(body){headers['content-type']='application/json';}if(session){headers.cookie=session.sessionCookie;headers['New-Api-User']=String(session.userId);}
   response=await fetchImpl(NATIVE_STATION_ORIGIN+path,{method,headers,body:body?JSON.stringify(body):undefined,redirect:'error',cache:'no-store',signal:controller.signal});
   if(controller.signal.aborted||!(response instanceof Response)||response.redirected||(response.url&&response.url!==NATIVE_STATION_ORIGIN+path)||!response.ok)fail('native_auth_unavailable');
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))fail('native_invalid_response');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))fail('native_invalid_response');
   reader=response.body?.getReader();if(!reader)fail('native_invalid_response');let total=0;const chunks=[];
   while(true){const {done,value}=await reader.read();if(controller.signal.aborted)fail('native_request_timeout');if(done)break;if(!(value instanceof Uint8Array)||(total+=value.byteLength)>32768||chunks.length>=4096)fail('native_invalid_response');chunks.push(value);}
   const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total)));
   if(!envelope||envelope.success!==true)fail('native_auth_rejected',400);
   return {data:envelope.data,headers:response.headers};
  })();
  try{return await Promise.race([work,deadline]);}catch(error){if(error instanceof NativeCustomerError)throw error;fail('native_auth_unavailable');}
  finally{clearTimeout(timer);controller.abort();cancel(reader??response?.body);try{reader?.releaseLock();}catch{}}
 }
 async function storeCall(method,...args){let timer;try{return await Promise.race([Promise.resolve().then(()=>store[method](...args)),new Promise((_,reject)=>timer=setTimeout(()=>reject(new NativeCustomerError('native_session_store_unavailable')),10000))]);}finally{clearTimeout(timer);}}
 async function session(request){const token=handleCookie(request.headers.get('cookie'));if(!token)fail('native_session_required',401);const record=await storeCall('get',hash(token));if(!record||!Number.isSafeInteger(record.userId)||record.userId<1||typeof record.sessionCookie!=='string'||!record.sessionCookie.length||record.sessionCookie.length>8192||/[\x00-\x1f\x7f]/.test(record.sessionCookie)||!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=now())fail('native_session_required',401);return {token,record};}
 return Object.freeze({async readCustomer(request,operation){
  if(!enabled)fail('native_auth_disabled');if(new URL(request.url).origin!==CUSTOMER_ORIGIN)fail('native_invalid_origin',403);
  const {record}=await session(request);
  return createNativeCustomerReader({enabled:true,stationOrigin:NATIVE_STATION_ORIGIN,userId:record.userId,sessionCookie:record.sessionCookie,fetchImpl}).read(operation);
 },async handle(request){
  const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
  const send=(body,status=200,cookie)=>new Response(JSON.stringify(body),{status,headers:{...headers,...(cookie?{'set-cookie':cookie}:{})}});
  try{
   if(!enabled)fail('native_auth_disabled');const url=new URL(request.url);if(url.origin!==CUSTOMER_ORIGIN)fail('native_invalid_origin',403);
   const operation=url.pathname.slice(NATIVE_AUTH_PREFIX.length+1);
   if(!url.pathname.startsWith(NATIVE_AUTH_PREFIX+'/')||url.search||!['login','register','logout','self'].includes(operation))fail('native_unknown_route',404);
   if(operation==='self'){
    if(request.method!=='GET')fail('native_invalid_request',405);const {record}=await session(request);const result=await transport('/api/dist/user/self',{session:record});if(result.data?.id!==record.userId)fail('native_owner_mismatch',403);return send({success:true,authority:'subrouter-native-station',user:project(result.data)});
   }
   if(request.method!=='POST')fail('native_invalid_request',405);
   if(request.headers.get('origin')!==CUSTOMER_ORIGIN||request.headers.get('sec-fetch-site')==='cross-site')fail('native_invalid_origin',403);
   if(operation==='logout'){
    const {token,record}=await session(request);await storeCall('delete',hash(token));
    try{await transport('/api/dist/user/logout',{method:'POST',session:record});}catch{/* Local session is revoked even if native logout is unconfirmed. */}
    return send({success:true},200,`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
   }
   if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))fail('native_invalid_request',415);
   const reader=request.body?.getReader();if(!reader)fail('native_invalid_request',400);let total=0;const chunks=[];
   let bodyTimer;const bodyDeadline=new Promise((_,reject)=>bodyTimer=setTimeout(()=>{cancel(reader);reject(new NativeCustomerError('native_body_timeout',408));},5000));
   const bodyRead=(async()=>{while(true){const {value,done}=await reader.read();if(done)break;if(!(value instanceof Uint8Array)||(total+=value.byteLength)>8192||chunks.length>=8192)fail('native_invalid_request',413);chunks.push(value);}})();
   try{await Promise.race([bodyRead,bodyDeadline]);}finally{clearTimeout(bodyTimer);cancel(reader);try{reader.releaseLock();}catch{}}
   const input=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total))),operation==='login'?['username','password','acceptedTerms']:['username','password','email','verification_code','aff_code','acceptedTerms']);
   if(input.acceptedTerms!==true||typeof input.username!=='string'||!input.username.length||input.username.length>64||typeof input.password!=='string'||input.password.length<1||input.password.length>128)fail('native_invalid_request',400);
   const body={username:input.username,password:input.password};if(operation==='register'){if(input.password.length<8||input.password.length>20)fail('native_invalid_request',400);for(const k of ['email','verification_code','aff_code'])if(input[k]!==undefined){if(typeof input[k]!=='string'||input[k].length>254||/[\x00-\x1f\x7f]/.test(input[k]))fail('native_invalid_request',400);body[k]=input[k];}}
   const result=await transport('/api/dist/user/'+operation,{method:'POST',body});
   if(operation==='register')return send({success:true,needsLogin:true});
   const userId=result.data?.id;if(!Number.isSafeInteger(userId)||userId<1)fail('native_invalid_session');
   const record={userId,sessionCookie:upstreamCookies(result.headers),expiresAt:now()+3600000};
   const self=await transport('/api/dist/user/self',{session:record});if(self.data?.id!==userId)fail('native_owner_mismatch',403);
   const previous=handleCookie(request.headers.get('cookie'));if(previous)await storeCall('delete',hash(previous));const token=randomBytes(32).toString('hex');await storeCall('put',hash(token),record);
   return send({success:true,authority:'subrouter-native-station',user:project(self.data)},200,`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`);
  }catch(error){return send({success:false,error:error instanceof NativeCustomerError?error.code:'native_auth_unavailable'},error instanceof NativeCustomerError?error.status:503);}
 }});
}

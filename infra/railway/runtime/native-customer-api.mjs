// Native station remains the only key, balance and usage authority. No local ledger.
import {NATIVE_STATION_ORIGIN,NativeCustomerError,createNativeCustomerReader} from './subrouter-native-customer.mjs';
const PREFIX='/api/native/customer',ORIGIN='https://apiwild.com';
const error=(code,status=503)=>{throw new NativeCustomerError(code,status);};
const object=(v,fields)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!fields.includes(k)))error('native_invalid_request',400);return v;};
const response=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
async function boundedJson(stream,max=8192,timeout=5000){
 const reader=stream?.getReader();if(!reader)error('native_invalid_request',400);let timer,total=0;const chunks=[];
 try{return await Promise.race([(async()=>{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>max)error('native_body_too_large',413);chunks.push(next.value);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));})(),new Promise((_,reject)=>timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new NativeCustomerError('native_request_timeout',408));},timeout))]);}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export function createNativeCustomerApi({auth,enabled=false,keyWritesEnabled=false,fetchImpl=fetch,billingFactory}={}){
 if(typeof enabled!=='boolean'||typeof keyWritesEnabled!=='boolean'||typeof auth?.withCustomer!=='function'||typeof auth?.readCustomer!=='function'||typeof fetchImpl!=='function'||(billingFactory!==undefined&&typeof billingFactory!=='function'))error('native_customer_unconfigured');
 async function transport(session,path,method='GET',body){
  const controller=new AbortController();let timer,reply;
  try{return await Promise.race([(async()=>{
   reply=await fetchImpl(NATIVE_STATION_ORIGIN+path,{method,headers:{cookie:session.sessionCookie,'New-Api-User':String(session.userId),accept:'application/json',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',cache:'no-store',signal:controller.signal});
   if(!(reply instanceof Response)||!reply.ok||reply.redirected||(reply.url&&reply.url!==NATIVE_STATION_ORIGIN+path)||!/^application\/json(?:\s*;|$)/i.test(reply.headers.get('content-type')||''))error('native_request_unconfirmed');
   const envelope=await boundedJson(reply.body,524288,10000);if(envelope?.success!==true)error('native_request_unconfirmed');return envelope.data;
  })(),new Promise((_,reject)=>timer=setTimeout(()=>{controller.abort();void reply?.body?.cancel().catch(()=>{});reject(new NativeCustomerError('native_request_timeout'));},10000))]);}
  finally{clearTimeout(timer);controller.abort();}
 }
 return Object.freeze({async handle(request){
  try{
   if(!enabled)error('native_customer_disabled');const url=new URL(request.url);if(url.origin!==ORIGIN||url.search||!url.pathname.startsWith(PREFIX+'/'))error('native_invalid_origin',403);
   const operation=url.pathname.slice(PREFIX.length+1);
   if(request.method==='GET'&&['account','usage','keys','logs','logStats'].includes(operation))return response({success:true,data:await auth.readCustomer(request,operation)});
   if(request.method==='GET'&&['billing/info','billing/history'].includes(operation)){
    if(!billingFactory)error('native_billing_unavailable');return response({success:true,data:await auth.withCustomer(request,s=>billingFactory(s).read(operation.split('/')[1]))});
   }
   if(!['POST','DELETE'].includes(request.method))error('native_unknown_route',404);
   if(request.headers.get('origin')!==ORIGIN||request.headers.get('sec-fetch-site')==='cross-site')error('native_invalid_origin',403);
   if(operation==='billing/checkout'&&request.method==='POST'){
    if(!billingFactory)error('native_billing_unavailable');const input=object(await boundedJson(request.body),['amountCents','currency']);
    return response({success:true,data:await auth.withCustomer(request,s=>billingFactory(s).checkout(input))});
   }
   if(!keyWritesEnabled)error('native_key_writes_disabled');
   if(operation==='keys'&&request.method==='POST'){
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))error('native_invalid_request',415);
    const input=object(await boundedJson(request.body),['name','models','quotaUsdCents','expiresAt']);
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>64||/[\x00-\x1f\x7f]/.test(input.name)||!Array.isArray(input.models)||input.models.length<1||input.models.length>39||new Set(input.models).size!==input.models.length||input.models.some(m=>typeof m!=='string'||!m||m.length>160||/[\x00-\x20,\x7f]/.test(m))||!Number.isSafeInteger(input.quotaUsdCents)||input.quotaUsdCents<1||input.quotaUsdCents>250000||typeof input.expiresAt!=='string')error('native_invalid_request',400);
    const expires=Date.parse(input.expiresAt);if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+365*86400000)error('native_invalid_request',400);
    const value=await auth.withCustomer(request,async session=>{
     const models=await transport(session,'/api/dist/site/models');if(!Array.isArray(models))error('native_models_unverified');
     const names=new Set(models.filter(m=>typeof m==='string'||m?.enabled!==false).map(m=>typeof m==='string'?m:m.model_name||m.id||m.name));if(input.models.some(m=>!names.has(m)))error('native_model_unavailable',409);
     const created=await transport(session,'/api/dist/token/create','POST',{name:input.name.trim(),type:'normal',expired_time:Math.floor(expires/1000),unlimited_quota:false,remain_quota:input.quotaUsdCents*5000,model_limits:input.models.join(',')});
     if(typeof created?.key!=='string'||!/^sk-[A-Za-z0-9_-]{16,256}$/.test(created.key))error('native_key_creation_unconfirmed');
     return {key:created.key,authority:'subrouter-native-station',baseUrl:'https://apiwild.com/v1',models:input.models,quotaUsdCents:input.quotaUsdCents,expiresAt:new Date(expires).toISOString()};
    });return response({success:true,data:value},201);
   }
   const match=operation.match(/^keys\/([1-9][0-9]{0,14})$/);
   if(match&&request.method==='DELETE'){
    const id=Number(match[1]);await auth.withCustomer(request,async session=>{
     const list=await transport(session,'/api/dist/token/list');if(!Array.isArray(list)||!list.some(k=>k.id===id))error('native_key_not_found',404);
     await transport(session,'/api/dist/token/'+id,'DELETE');
    });return response({success:true,revokedKeyId:id});
   }
   error('native_unknown_route',404);
  }catch(e){return response({success:false,error:e instanceof NativeCustomerError?e.code:'native_customer_unavailable',automaticRetry:false},e instanceof NativeCustomerError?e.status:503);}
 }});
}

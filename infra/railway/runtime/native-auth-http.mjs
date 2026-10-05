import {Readable} from 'node:stream';
import {createNativeAuth,NATIVE_AUTH_PREFIX} from './subrouter-native-auth.mjs';
import {createNativeSessionStore} from './native-session-store.mjs';
import {NATIVE_STATION_ORIGIN} from './subrouter-native-customer.mjs';
import {createNativeCustomerApi} from './native-customer-api.mjs';
import {createNativeRelayApi} from './native-relay-api.mjs';
import {createNativeBilling} from './subrouter-native-billing.mjs';
const instances=new WeakSet();
export function isNativeAuthHttp(value){return instances.has(value);}
export function createNativeAuthHttp({enabled=false,customerOperationsEnabled=false,keyWritesEnabled=false,nativeCheckoutEnabled=false,relayEnabled=false,allowedModels=[],fetchImpl,sessionStore}={}) {
 if(typeof enabled!=='boolean')throw Error('Invalid native auth configuration.');
 const auth=createNativeAuth({enabled,stationOrigin:NATIVE_STATION_ORIGIN,customerOrigin:'https://apiwild.com',fetchImpl,sessionStore:sessionStore??createNativeSessionStore()});
 const customer=createNativeCustomerApi({auth,enabled:customerOperationsEnabled,keyWritesEnabled,fetchImpl,
  billingFactory:session=>createNativeBilling({enabled:customerOperationsEnabled,nativeCheckoutEnabled,stationOrigin:NATIVE_STATION_ORIGIN,...session,fetchImpl})});
 const relay=createNativeRelayApi({enabled:relayEnabled,allowedModels,fetchImpl});
 // Bounded process-wide admission protects the native login service and memory.
 let active=0;const attempts=[];
 const port=Object.freeze({async handle(req,res){
  req.once('error',()=>{});res.once('error',()=>{});
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));req.resume();};
  if(Object.keys(req.headers).some(name=>name.toLowerCase().startsWith('oai-authenticated-')))return send(403,{error:'native_untrusted_identity'});
  if(active>=20)return send(429,{error:'native_rate_limited'});
  const cutoff=Date.now()-60000;while(attempts.length&&attempts[0]<cutoff)attempts.shift();
  if(req.headers.host!=='apiwild.com'||typeof req.url!=='string'||!(req.url.startsWith(NATIVE_AUTH_PREFIX+'/')||req.url.startsWith('/api/native/customer/')||req.url==='/v1/chat/completions'))return send(403,{error:'native_invalid_origin'});
  if(req.method==='POST'&&req.url.startsWith(NATIVE_AUTH_PREFIX+'/')&&req.url!==NATIVE_AUTH_PREFIX+'/logout'){if(attempts.length>=60)return send(429,{error:'native_rate_limited'});attempts.push(Date.now());}
  active++;
  try{
   const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
   const request=new Request('https://apiwild.com'+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
   const result=await(req.url.startsWith('/api/native/customer/')?customer.handle(request):req.url==='/v1/chat/completions'?relay.handle(request):auth.handle(request));res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
  }catch{if(!res.headersSent)send(503,{error:'native_auth_unavailable'});else res.end();}
  finally{active--;req.resume();}
 }});instances.add(port);return port;
}

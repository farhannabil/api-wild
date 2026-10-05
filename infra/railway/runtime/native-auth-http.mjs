import {Readable} from 'node:stream';
import {createNativeAuth,NATIVE_AUTH_PREFIX} from './subrouter-native-auth.mjs';
import {createNativeSessionStore} from './native-session-store.mjs';
import {NATIVE_STATION_ORIGIN} from './subrouter-native-customer.mjs';
const instances=new WeakSet();
export function isNativeAuthHttp(value){return instances.has(value);}
export function createNativeAuthHttp({enabled=false,fetchImpl,sessionStore}={}) {
 if(typeof enabled!=='boolean')throw Error('Invalid native auth configuration.');
 const auth=createNativeAuth({enabled,stationOrigin:NATIVE_STATION_ORIGIN,customerOrigin:'https://apiwild.com',fetchImpl,sessionStore:sessionStore??createNativeSessionStore()});
 // Bounded process-wide admission protects the native login service and memory.
 let active=0;const attempts=[];
 const port=Object.freeze({async handle(req,res){
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));req.resume();};
  if(Object.keys(req.headers).some(name=>name.toLowerCase().startsWith('oai-authenticated-')))return send(403,{error:'native_untrusted_identity'});
  if(active>=20)return send(429,{error:'native_rate_limited'});
  const cutoff=Date.now()-60000;while(attempts.length&&attempts[0]<cutoff)attempts.shift();
  if(req.method==='POST'&&req.url!==NATIVE_AUTH_PREFIX+'/logout'){if(attempts.length>=60)return send(429,{error:'native_rate_limited'});attempts.push(Date.now());}
  if(req.headers.host!=='apiwild.com'||typeof req.url!=='string'||!req.url.startsWith(NATIVE_AUTH_PREFIX+'/'))return send(403,{error:'native_invalid_origin'});
  active++;
  try{
   const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
   const request=new Request('https://apiwild.com'+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
   const result=await auth.handle(request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
  }catch{if(!res.headersSent)send(503,{error:'native_auth_unavailable'});else res.end();}
  finally{active--;req.resume();}
 }});instances.add(port);return port;
}

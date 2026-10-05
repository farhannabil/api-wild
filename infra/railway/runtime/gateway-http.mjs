import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {isGatewayIngress} from './gateway-ingress.mjs';
import {isOwnedDiscoverySnapshot} from './owned-discovery-http.mjs';
const instances=new WeakSet();
export const isGatewayHttp=value=>instances.has(value);
export const isGatewayPath=path=>typeof path==='string'&&(['/api/account','/api/usage','/api/keys','/api/gateway/keys','/api/gateway','/api/research/tools','/v1/models','/v1/usage','/v1/chat/completions'].includes(path)||/^\/api\/(?:gateway\/)?keys\/[0-9a-f-]{36}$/.test(path));
export function createGatewayHttp({ingress,discovery}={}){
 if(!isGatewayIngress(ingress))throw Error('Invalid gateway ingress.');
 if(discovery!==undefined&&!isOwnedDiscoverySnapshot(discovery))throw Error('Invalid gateway discovery.');
 const adapter=Object.freeze({discovery,async handle(req,res){
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});res.end(JSON.stringify(value));req.resume();};
  if(req.headers.host!=='apiwild.com'||!isGatewayPath(req.url))return send(403,{error:'Invalid gateway origin.'});
  const controller=new AbortController();req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableEnded)controller.abort();});req.once('error',()=>controller.abort());
  try{const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
   const result=await ingress.handle(new Request('https://apiwild.com'+req.url,{method:req.method,headers,signal:controller.signal,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})}));
   if(!res.destroyed){res.writeHead(result.status,Object.fromEntries(result.headers));if(result.body)await pipeline(Readable.fromWeb(result.body),res,{signal:controller.signal});else res.end();}
   else await result.body?.cancel().catch(()=>{});
  }catch{if(!res.headersSent&&!res.destroyed)send(503,{error:'Gateway unavailable.',automaticRetry:false});}finally{req.resume();}
 }});instances.add(adapter);return adapter;
}

// Explicit owner-injected adapter only. The preparation CLI/default never mounts it.
import {isAaroUsageBridge,AARO_BILLING_ORIGIN} from './aaro-usage-bridge.mjs';
import {exactInteger,strictObject} from './supabase-gateway-rpc.mjs';
export const AARO_USAGE_PATH='/api/aaro/usage';
const instances=new WeakSet(),BODY_MAX=4096,RESPONSE_MAX=16384;
const responseHeaders={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
class IngressError extends Error{constructor(status){super('AARO ingress could not be verified.');this.status=status;}}
function validatedHeaders(request){
  if(request.url!==AARO_USAGE_PATH||request.readableEncoding)throw new IngressError(400);
  if(request.method!=='POST')throw new IngressError(405);
  const result=Object.create(null),sensitive=new Set(['host','origin','authorization','x-aaro-bridge','content-type','content-length','transfer-encoding','content-encoding','forwarded','x-forwarded-host','x-forwarded-proto']);
  for(let i=0;i<request.rawHeaders.length;i+=2){
    const name=request.rawHeaders[i].toLowerCase();if(name.startsWith('oai-authenticated-'))throw new IngressError(403);
    if(sensitive.has(name)){if(Object.hasOwn(result,name))throw new IngressError(400);result[name]=request.rawHeaders[i+1];}
  }
  // Never convert a client-selected Host/forwarded host into canonical authority.
  if(result.host!=='apiwild.com'||result.origin!==AARO_BILLING_ORIGIN||result.forwarded!==undefined
    ||(result['x-forwarded-host']!==undefined&&result['x-forwarded-host']!=='apiwild.com')||result['x-forwarded-proto']!=='https')throw new IngressError(403);
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(result['content-type']||'')||result['content-encoding']!==undefined)throw new IngressError(415);
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(result['x-aaro-bridge']||'')||!/^Bearer [A-Za-z0-9_.-]{1,4096}$/.test(result.authorization||''))throw new IngressError(403);
  if(result['transfer-encoding']!==undefined&&(result['transfer-encoding']!=='chunked'||result['content-length']!==undefined))throw new IngressError(400);
  if(result['content-length']!==undefined&&(!/^(?:0|[1-9][0-9]*)$/.test(result['content-length'])||Number(result['content-length'])>BODY_MAX))throw new IngressError(413);
  return result;
}
function readBody(request,signal,length){return new Promise((resolve,reject)=>{
  let size=0,finished=false;const chunks=[];
  const finish=error=>{if(finished)return;finished=true;request.off('data',data);request.off('end',end);request.off('aborted',aborted);request.off('error',aborted);signal.removeEventListener('abort',abort);error?(request.pause(),reject(error)):resolve(Buffer.concat(chunks,size));};
  const data=chunk=>{if(!(chunk instanceof Uint8Array)){finish(new IngressError(400));return;}size+=chunk.byteLength;if(size>BODY_MAX){finish(new IngressError(413));return;}chunks.push(Buffer.from(chunk));};
  const end=()=>finish(size<1||(length!==undefined&&size!==Number(length))?new IngressError(400):undefined);
  const aborted=()=>finish(new IngressError(400)),abort=()=>finish(new IngressError(504));
  request.on('data',data);request.once('end',end);request.once('aborted',aborted);request.once('error',aborted);signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();else if(request.aborted||request.destroyed)aborted();
});}
function boundedWait(promise,signal){return new Promise((resolve,reject)=>{
  const abort=()=>reject(new IngressError(504));signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();
});}
async function responseBody(reply,signal){
  if(!(reply instanceof Response)||!/^application\/json(?:;|$)/i.test(reply.headers.get('content-type')||''))throw new IngressError(503);
  const reader=reply.body?.getReader();if(!reader)throw new IngressError(503);let size=0;const chunks=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{for(;;){if(signal.aborted)throw new IngressError(504);const {done,value}=await boundedWait(reader.read(),signal);if(done)break;size+=value.byteLength;
      if(size>RESPONSE_MAX){await reader.cancel();throw new IngressError(503);}chunks.push(value);}return Buffer.concat(chunks,size);
  }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
function send(response,status,body,close=false){
  if(response.destroyed||response.writableEnded)return;
  try{response.writeHead(status,{...responseHeaders,'content-length':body.byteLength,...(close?{connection:'close'}:{})});response.end(body);}catch{response.destroy();}
}
export function isAaroUsageIngress(value){return instances.has(value);}
export function createAaroUsageIngress(config={}){
  strictObject(config,['bridge','deadlineMilliseconds','maxConcurrent']);
  if(!isAaroUsageBridge(config.bridge))throw new IngressError(503);
  const bridge=config.bridge,deadline=exactInteger(config.deadlineMilliseconds??15000,1,15000),maxConcurrent=exactInteger(config.maxConcurrent??4,1,16);let active=0;
  const ingress=Object.freeze({async handle(request,response){
    request.once('error',()=>{});response.once('error',()=>{});
    if(active>=maxConcurrent){send(response,503,Buffer.from(JSON.stringify({error:'AARO ingress unavailable.'})),true);return;}
    active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadline);
    const disconnected=()=>controller.abort(),closed=()=>{if(!response.writableEnded)controller.abort();};
    request.once('aborted',disconnected);response.once('close',closed);
    try{
      const headers=validatedHeaders(request),body=await readBody(request,controller.signal,headers['content-length']);
      const webRequest=new Request(AARO_BILLING_ORIGIN+AARO_USAGE_PATH,{method:'POST',headers:{Origin:headers.origin,'Content-Type':headers['content-type'],Authorization:headers.authorization,'X-AARO-Bridge':headers['x-aaro-bridge']},body,signal:controller.signal});
      const reply=await boundedWait(bridge(webRequest),controller.signal),serialized=await responseBody(reply,controller.signal);
      if(controller.signal.aborted)throw new IngressError(504);send(response,reply.status,serialized,reply.status>=400);
    }catch(error){const status=controller.signal.aborted?504:error instanceof IngressError?error.status:503;
      send(response,status,Buffer.from(JSON.stringify({error:'AARO request could not be verified.'})),true);
    }finally{clearTimeout(timer);request.off('aborted',disconnected);response.off('close',closed);active--;}
  }});instances.add(ingress);return ingress;
}

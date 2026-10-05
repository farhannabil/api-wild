// Native token and quota authority stays upstream. No owner key or local credit ledger.
import {createHash} from 'node:crypto';
const ENDPOINT='https://apiwild.subrouter.ai/v1/chat/completions';
const json=(status,value)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createNativeRelayApi({enabled=false,allowedModels=[],fetchImpl=fetch}={}){
 if(typeof enabled!=='boolean'||!Array.isArray(allowedModels)||allowedModels.some(m=>typeof m!=='string'||!m||m.length>160)||typeof fetchImpl!=='function')throw Error('Invalid native relay configuration.');
 const models=new Set(allowedModels),attempts=new Map();let active=0;
 return Object.freeze({async handle(request){
  if(!enabled)return json(503,{error:'native_relay_disabled',automaticRetry:false});
  if(active>=4)return json(429,{error:'native_relay_busy',automaticRetry:false});
  const url=new URL(request.url),authorization=request.headers.get('authorization')||'',key=request.headers.get('idempotency-key')||'';
  if(url.origin!=='https://apiwild.com'||url.pathname!=='/v1/chat/completions'||url.search||request.method!=='POST'||!/^Bearer sk-[A-Za-z0-9_-]{16,256}$/.test(authorization)||!/^[A-Za-z0-9_-]{16,100}$/.test(key))return json(400,{error:'native_invalid_relay_request',automaticRetry:false});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||request.headers.has('content-encoding'))return json(415,{error:'native_invalid_relay_request',automaticRetry:false});
  let attempt,bodyReader,upstreamReader;const controller=new AbortController();let timer;active++;
  try{
   timer=setTimeout(()=>{controller.abort();void bodyReader?.cancel().catch(()=>{});void upstreamReader?.cancel().catch(()=>{});},30000);
   bodyReader=request.body?.getReader();if(!bodyReader)throw Error();let size=0;const chunks=[];
   for(;;){if(controller.signal.aborted)throw Error();const next=await bodyReader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536)throw Error();chunks.push(next.value);}
   const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['model','messages','max_tokens','temperature','stream'].includes(k))||!models.has(body.model)||body.stream===true||!Array.isArray(body.messages)||body.messages.length<1||body.messages.length>30)throw Error();
   let chars=0;for(const m of body.messages){if(!m||typeof m!=='object'||Object.keys(m).some(k=>!['role','content'].includes(k))||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.length)throw Error();chars+=m.content.length;}
   if(chars>60000||!body.messages.some(m=>m.role==='user'))throw Error();
   const max=body.max_tokens??1024;if(!Number.isSafeInteger(max)||max<1||max>4096||(body.temperature!==undefined&&(typeof body.temperature!=='number'||!Number.isFinite(body.temperature)||body.temperature<0||body.temperature>2)))throw Error();
   const serialized=JSON.stringify({...body,max_tokens:max,stream:false});if(serialized.includes(authorization.slice(7)))throw Error();
   // Never discard a dispatch identity and silently permit another paid attempt.
   // This bounded process store requires one replica; restart recovery needs a
   // durable trusted store before public retry/idempotency guarantees are made.
   const identity=hash(authorization+'\0'+key),fingerprint=hash(serialized),prior=attempts.get(identity);
   if(prior){if(prior.fingerprint!==fingerprint)return json(409,{error:'native_idempotency_conflict',automaticRetry:false});return prior.value?json(prior.status,prior.value):json(409,{error:'native_request_pending',automaticRetry:false});}
   if(attempts.size>=1000)return json(503,{error:'native_relay_capacity',automaticRetry:false});
   attempt={fingerprint,pending:true};attempts.set(identity,attempt);
   // Exactly one attempt. Upstream is responsible for real authorization/billing.
   const work=(async()=>{
    const reply=await fetchImpl(ENDPOINT,{method:'POST',headers:{authorization,'content-type':'application/json'},body:serialized,redirect:'error',cache:'no-store',signal:controller.signal});
    if(controller.signal.aborted)throw Error();
    if(!(reply instanceof Response)||reply.redirected||(reply.url&&reply.url!==ENDPOINT))throw Error();
    if(!reply.ok){attempt.status=[401,403,402,429].includes(reply.status)?reply.status:503;attempt.value={error:'native_upstream_rejected',automaticRetry:false};return;}
    if(!/^application\/json(?:\s*;|$)/i.test(reply.headers.get('content-type')||''))throw Error();
    upstreamReader=reply.body?.getReader();if(!upstreamReader)throw Error();let count=0;const parts=[];
    for(;;){const next=await upstreamReader.read();if(controller.signal.aborted)throw Error();if(next.done)break;count+=next.value.byteLength;if(count>1048576)throw Error();parts.push(next.value);}
    const raw=Buffer.concat(parts).toString('utf8');if(raw.includes(authorization.slice(7)))throw Error();const value=JSON.parse(raw);
    if(typeof value.id!=='string'||value.id.length>160||value.model!==body.model||!Array.isArray(value.choices)||value.choices.length!==1||value.choices[0]?.message?.role!=='assistant'||typeof value.choices[0].message.content!=='string'||value.choices[0].message.tool_calls?.length||!Number.isSafeInteger(value.usage?.prompt_tokens)||value.usage.prompt_tokens<0||!Number.isSafeInteger(value.usage.completion_tokens)||value.usage.completion_tokens<0||value.usage.completion_tokens>max)throw Error();
    attempt.status=200;attempt.value={id:value.id,object:'chat.completion',model:value.model,choices:[{index:0,message:{role:'assistant',content:value.choices[0].message.content},finish_reason:['stop','length','content_filter'].includes(value.choices[0].finish_reason)?value.choices[0].finish_reason:null}],usage:{prompt_tokens:value.usage.prompt_tokens,completion_tokens:value.usage.completion_tokens,total_tokens:value.usage.prompt_tokens+value.usage.completion_tokens}};
   })();
   await Promise.race([work,new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error()),{once:true}))]);
   attempt.pending=false;return json(attempt.status,attempt.value);
  }catch{if(attempt){attempt.pending=false;attempt.status=503;attempt.value={error:'native_request_requires_reconciliation',automaticRetry:false};}return json(attempt?503:400,{error:attempt?'native_request_requires_reconciliation':'native_invalid_relay_request',automaticRetry:false});}
  finally{clearTimeout(timer);active--;void bodyReader?.cancel().catch(()=>{});void upstreamReader?.cancel().catch(()=>{});}
 }});
}

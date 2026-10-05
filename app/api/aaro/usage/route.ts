import {env} from 'cloudflare:workers';
import {respond,RequestError,readTextBounded} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner} from '@/lib/billing';
import {reserveAaroUsage,claimAaroUsage,settleAaroUsage,uncertainAaroUsage} from '@/lib/aaro-usage';
import {issueAaroReceipt,verifyAaroReceipt} from '@/lib/aaro-receipt';

// Only AARO's server may reserve or settle; a customer bearer alone is insufficient.
export async function POST(request:Request){
 const expected=(env as typeof env&{AARO_BRIDGE_KEY?:string}).AARO_BRIDGE_KEY;
 const provided=request.headers.get('x-aaro-bridge')||'';
 if(!expected||expected.length<32)return respond({error:'Credit bridge is awaiting configuration.'},503);
 let diff=expected.length^provided.length;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^(provided.charCodeAt(i)||0);
 if(diff)return respond({error:'Unauthorized credit bridge.'},403);
 try{
  const raw=await readTextBounded(request,4096);let body;try{body=JSON.parse(raw);}catch{throw new RequestError('Invalid JSON.',400);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new RequestError('Invalid usage request.',400);
  const owner=body.action!=='reserve'&&body.receipt?await verifyAaroReceipt(expected,body.receipt,body.id):billingOwner((await billingIdentity(request)).id);
  if(body.action==='reserve'){
   const allowed=['openai/gpt-6-luna','anthropic/claude-haiku-4.5','google/gemini-3.8-flash','moonshotai/kimi-k3','alibaba/qwen3.5-flash','deepseek/deepseek-v4.1-flash'];
   if(typeof body.requestKey!=='string'||typeof body.payloadHash!=='string'||!allowed.includes(body.model)||!Number.isSafeInteger(body.maximumCredits)||body.maximumCredits<1||body.maximumCredits>1000000)throw new RequestError('Invalid credit reservation.',400);
   const {record,fresh}=await reserveAaroUsage(owner,body.requestKey,body.payloadHash,body.model,body.maximumCredits);
   // Never repeat an inference after a lost response with the same request key.
   if(!fresh)throw new RequestError('This request was already received. Check your history before trying again.',409);
   const claimed=await claimAaroUsage(owner,record.id);if(!claimed)throw new RequestError('Credit reservation could not be claimed.',409);
   return respond({id:record.id,receipt:await issueAaroReceipt(expected,record.id,owner)});
  }
  if(typeof body.id!=='string'||body.id.length>100)throw new RequestError('Invalid usage reference.',400);
  if(body.action==='settle')return respond(await settleAaroUsage(owner,body.id,{state:'succeeded',inputTokens:body.inputTokens,outputTokens:body.outputTokens}));
  if(body.action==='uncertain'){await uncertainAaroUsage(owner,body.id);return respond({held:true});}
  if(body.action==='failed'&&[402,429].includes(body.providerStatus))return respond(await settleAaroUsage(owner,body.id,{state:'failed'}));
  throw new RequestError('Invalid usage action.',400);
 }catch(error){return respond({error:error instanceof RequestError?error.message:'Credit service unavailable.'},error instanceof RequestError?error.status:error instanceof SyntaxError?400:503);}
}

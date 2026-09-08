import {z} from 'zod';
import {database,respond,readTextBounded,RequestError} from '@/db/service';
import {hashKey} from '@/lib/key-auth';
import {gatewayIdentity,gatewayOrigin} from '@/lib/gateway-auth';
import {gatewayConfig} from '@/lib/gateway-config';
import {routeModel,rateVersion,gatewayModels} from '@/lib/gateway-catalog';
import {maintainGateway,savedGatewayResult,reserveGateway,claimGateway,progressGateway,finishGateway,uncertainGateway,type ProviderCosts} from '@/lib/gateway-ledger';
import {utf8Bound,wavAudio,estimateGateway,completeText,searchEvidence,transcribeAudio,speakText,ProviderRejected,type ProviderUsage,type Source} from '@/lib/gateway-providers';
const schema=z.object({mode:z.enum(['chat','code','research','voice','transcribe','speak']).default('chat'),model:z.string().max(120).optional(),messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(16000)})).max(30).default([]),max_tokens:z.number().int().min(1).max(2048).default(1024),stream:z.literal(false).optional(),audioBase64:z.string().max(2600000).optional(),text:z.string().max(4000).optional()}).strict();
export async function gatewayPost(r:Request,openai=false){
 let record:Awaited<ReturnType<typeof reserveGateway>>['record']|undefined;
 const costs:ProviderCosts={together:0,you:0,deepgram:0},usage:ProviderUsage[]=[];
 try{
  gatewayOrigin(r);
  if(!r.headers.get('content-type')?.includes('application/json'))throw new RequestError('Send application/json.',415);
  // Authenticate before reading the potentially larger voice payload.
  const identity=await gatewayIdentity(r);
  const raw=JSON.parse(await readTextBounded(r,2700000));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RequestError('Send a JSON object.',400);
  if(openai){raw.mode=(raw.model==='apiwild/code'||raw.model===gatewayModels[1].model)?'code':raw.model==='apiwild/research'?'research':'chat';}
  const parsed=schema.safeParse(raw);if(!parsed.success)throw new RequestError('Check mode, messages and limits. Streaming and arbitrary model routes are not supported by this endpoint.',400);
  const body=parsed.data;await gatewayIdentity(r,body.mode);
  const requestKey=r.headers.get('idempotency-key');if(!requestKey||!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey))throw new RequestError('Provide an Idempotency-Key of 16–100 letters, digits, underscores or hyphens.',400);
  if(new TextEncoder().encode(body.messages.map(m=>m.content).join('')).length>16000)throw new RequestError('Conversation exceeds the 16 KB input limit.',413);
  if(!['voice','transcribe','speak'].includes(body.mode)&&(!body.messages.length||body.messages.at(-1)?.role!=='user'))throw new RequestError('End the conversation with your message.',400);
  const model=routeModel(body.mode,body.model),audio=body.audioBase64?wavAudio(body.audioBase64):undefined;
  if(['voice','transcribe'].includes(body.mode)&&!audio)throw new RequestError('A WAV recording is required.',400);
  if(!['voice','transcribe'].includes(body.mode)&&audio)throw new RequestError('Audio is only accepted by voice and transcribe.',400);
  if(body.mode==='speak'&&(!body.text||Array.from(body.text).length>2000))throw new RequestError('Speech accepts 1–2,000 characters.',400);
  await maintainGateway();
  const config=gatewayConfig();if(!config.ready[body.mode]||!identity.owner.startsWith('live:'))throw new RequestError('This capability is awaiting activation. No credits were used.',503);
  const estimate=estimateGateway(body.mode,body.messages,body.max_tokens,audio?.seconds,body.text);
  const reserved=await reserveGateway(identity,requestKey,await hashKey(JSON.stringify({body,format:openai?'openai':'native'})),body.mode,model.model,estimate,config.caps);
  if(!reserved.fresh){const previous=reserved.record;const cached=await savedGatewayResult(previous);if(cached)return respond({...cached,replayed:true},previous.state==='failed'?502:200);throw new RequestError(['reserved','executing','uncertain'].includes(previous.state)?'This request is already processing or awaiting reconciliation. Check its status; do not create a new request.':'The request is complete; its saved response has expired. Check usage history.',409);}
  record=reserved.record;
  if(!await claimGateway(record.id))throw new RequestError('This request cannot be dispatched again.',409);
  const messages=[...body.messages];let finishReason='stop';let sources:Source[]=[],transcript='',text='',audioResult:Record<string,unknown>={};
  const progress=async()=>{await progressGateway(record!.id,costs,usage);if(costs.together>estimate.together||costs.you>estimate.you||costs.deepgram>estimate.deepgram)throw new ProviderRejected('A provider exceeded the reserved rate bound.');};
  const invoke=async<T extends {usage:ProviderUsage}>(provider:string,stage:string,call:(receipt:(id:string)=>Promise<void>,attempt:string)=>Promise<T>)=>{const attemptId=record!.id+':'+stage,entry:ProviderUsage={provider,requestId:'',attemptId,stage,status:'dispatched'};usage.push(entry);await progress();const value=await call(async id=>{entry.requestId=id;entry.status='receipt_received';await progress()},attemptId);Object.assign(entry,value.usage,{status:'confirmed'});return value;};
  if(audio){const t=await invoke('deepgram','transcribe',(receipt,attempt)=>transcribeAudio(audio,receipt,attempt));costs.deepgram+=t.cost;transcript=t.text;await progress();if(body.mode==='voice'){if(!transcript.trim())throw new ProviderRejected('No speech was detected.');messages.push({role:'user',content:utf8Bound(transcript,16000)});}}
  if(body.mode==='research'){const s=await invoke('you','search',receipt=>searchEvidence(utf8Bound(messages.at(-1)!.content,1000),receipt));costs.you+=s.cost;sources=s.sources;await progress();}
  if(!['speak','transcribe'].includes(body.mode)){const completion=await invoke('together','completion',receipt=>completeText(body.mode,messages,body.max_tokens,sources,receipt));text=completion.text;finishReason=completion.finishReason;costs.together+=completion.cost;await progress();}
  if(body.mode==='voice'||body.mode==='speak'){const speech=await invoke('deepgram','speak',(receipt,attempt)=>speakText(body.mode==='speak'?body.text!:text,receipt,attempt));costs.deepgram+=speech.cost;audioResult={audioBase64:speech.audioBase64,audioType:speech.audioType,spokenCharacters:speech.spokenCharacters};await progress();}
  if(body.mode==='transcribe')text=transcript;if(body.mode==='speak')text=body.text!;
  const result={id:record.id,status:'succeeded',mode:body.mode,model:model.model,text,transcript:transcript||undefined,sources:sources.map(({title,url},i)=>({index:i+1,title,url})),...audioResult,costMicros:Math.min(costs.together+costs.you+costs.deepgram,record.reserved_micros),reservedMicros:record.reserved_micros,rateVersion,usage};
  const output=openai?{id:record.id,object:'chat.completion',created:Math.floor(Date.now()/1000),model:model.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:finishReason}],usage:{prompt_tokens:usage.find(u=>u.provider==='together')?.inputTokens||0,completion_tokens:usage.find(u=>u.provider==='together')?.outputTokens||0,total_tokens:(usage.find(u=>u.provider==='together')?.inputTokens||0)+(usage.find(u=>u.provider==='together')?.outputTokens||0)},apiwild:result}:result;
  await finishGateway(record,costs,output,usage);
  return respond(output);
 }catch(e){
  if(record){if(e instanceof ProviderRejected){const error={id:record.id,status:'failed',error:e.message,costMicros:0};try{await finishGateway(record,costs,error,usage,'provider_rejected');return respond(error,502);}catch{/* Preserve the reservation if settlement did not commit. */}}
   try{await uncertainGateway(record.id,costs,usage);}catch{/* A stale executing lease is retained by maintenance. */}
   return respond({id:record.id,status:'uncertain',error:'Completion is awaiting reconciliation. The reserved amount remains held; check request history before retrying.'},503);
  }
  return respond({error:e instanceof RequestError?e.message:e instanceof SyntaxError?'Invalid JSON.':e instanceof Error&&e.message.startsWith('Choose an available')?e.message:'The request could not be completed.'},e instanceof RequestError?e.status:e instanceof SyntaxError||e instanceof Error&&e.message.startsWith('Choose an available')?400:503);
 }
}

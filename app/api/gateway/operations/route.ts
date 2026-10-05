import {database,readTextBounded,respond,RequestError} from '@/db/service';
import {gatewayOperator} from '@/lib/gateway-operations';
import {finishGateway,maintainGateway,type GatewayRecord} from '@/lib/gateway-ledger';
import {z} from 'zod';
import {maintainAaroUsage} from '@/lib/aaro-usage';
function failure(e:unknown){return respond({error:e instanceof RequestError?e.message:'Operations could not be completed.'},e instanceof RequestError?e.status:503);}
export async function GET(r:Request){try{
 await gatewayOperator(r);const db=database();
 const [requests,outbox]=await Promise.all([
  db.prepare("SELECT id,user_id,capability,model,state,reserved_micros,together_cost,you_cost,deepgram_cost,usage_json,error_code,updated_at FROM gateway_requests WHERE state='uncertain' ORDER BY updated_at LIMIT 100").all(),
  db.prepare("SELECT id,payload,created_at FROM gateway_outbox WHERE state='pending' ORDER BY created_at LIMIT 100").all()
 ]);return respond({uncertain:requests.results,outbox:outbox.results});
 }catch(e){return failure(e);}}
export async function POST(r:Request){try{
 await gatewayOperator(r);const raw=JSON.parse(await readTextBounded(r,12000));
 if(raw.action==='maintenance'){await maintainAaroUsage();return respond({states:await maintainGateway()});}
 if(raw.action==='acknowledge_export'){
  const b=z.object({action:z.literal('acknowledge_export'),ids:z.array(z.string().uuid()).min(1).max(100),destinationReceipt:z.string().min(5).max(500)}).strict().safeParse(raw);
  if(!b.success)throw new RequestError('Provide delivered event IDs and the destination receipt.',400);
  // An acknowledgement is allowed only after the consumer has durably deduplicated each event ID.
  const exported=await database().batch(b.data.ids.map(id=>database().prepare("UPDATE gateway_outbox SET state='exported',exported_at=?,export_receipt=? WHERE id=? AND state='pending'").bind(new Date().toISOString(),b.data.destinationReceipt,id)));
  return respond({acknowledged:exported.reduce((n,row)=>n+Number(row.meta.changes||0),0),requested:b.data.ids.length});
 }
 const schema=z.object({action:z.literal('resolve_failed'),id:z.string().uuid(),expectedUpdatedAt:z.string().min(10).max(40),providerCosts:z.object({together:z.number().int().min(0).max(1e9),you:z.number().int().min(0).max(1e9),deepgram:z.number().int().min(0).max(1e9)}).strict(),evidence:z.array(z.object({provider:z.enum(['subrouter','together','you','deepgram']),reference:z.string().min(5).max(1000),finding:z.string().min(10).max(2000)}).strict()).min(1).max(3),operatorVerified:z.literal(true)}).strict();
 const b=schema.safeParse(raw);if(!b.success)throw new RequestError('Provide the request version, verified provider costs and receipt evidence.',400);
 const db=database(),record=await db.prepare('SELECT * FROM gateway_requests WHERE id=?').bind(b.data.id).first<GatewayRecord&{updated_at:string}>();
 if(!record)throw new RequestError('Request not found.',404);
 if(record.state!=='uncertain'||record.updated_at!==b.data.expectedUpdatedAt)throw new RequestError('The request changed. Read its latest state before resolving.',409);
 const savedUsage=JSON.parse(record.usage_json||'[]'),attempts=Array.isArray(savedUsage)?savedUsage:[];
 const required=new Set(attempts.map((v:any)=>v.provider));
 // A worker interruption can happen before a first receipt. Require evidence for every reserved provider.
 if(record.together_reserved)required.add(attempts.some((v:any)=>v.provider==='subrouter')?'subrouter':'together');if(record.you_reserved)required.add('you');if(record.deepgram_reserved)required.add('deepgram');
 for(const provider of required)if(!b.data.evidence.some(e=>e.provider===provider))throw new RequestError('Include evidence for every potentially dispatched provider.',400);
 const audit={kind:'operator_resolution',operatorVerified:true,at:new Date().toISOString(),evidence:b.data.evidence};
 await finishGateway(record,b.data.providerCosts,{id:record.id,status:'failed',error:'The response could not be recovered. No customer usage was charged.',costMicros:0},[...attempts,audit],'operator_resolved_unrecoverable',b.data.expectedUpdatedAt);
 return respond({id:record.id,status:'failed',costMicros:0});
 }catch(e){return failure(e);}}

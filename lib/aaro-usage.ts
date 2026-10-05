import {env} from 'cloudflare:workers';
import {database,RequestError} from '@/db/service';

// Deliberately gated draft tariff, not a dollar conversion or provider-cost claim.
export const AARO_TARIFF_VERSION='aaro-token-units-2026-09-27.draft-1';
export function aaroUsageEnabled(){const c=env as typeof env&{AARO_USAGE_ENABLED?:string;AARO_TARIFF_VERSION?:string};return c.AARO_USAGE_ENABLED==='true'&&c.AARO_TARIFF_VERSION===AARO_TARIFF_VERSION;}
function integer(value:number){if(!Number.isSafeInteger(value)||value<0||value>10000000)throw new RequestError('Invalid credit usage.',400);return value;}
export function aaroCredits(inputTokens:number,outputTokens:number){return integer(integer(inputTokens)+4*integer(outputTokens));}
export type AaroUsageRecord={id:string;user_id:string;invoice_id:string;request_key:string;payload_hash:string;model:string;tariff_version:string;state:string;reserved_credits:number;actual_credits:number;input_tokens:number;output_tokens:number;created_at:string;updated_at:string;expires_at:string};
const held="state IN ('reserved','executing','uncertain')";
const used=`actual_credits+CASE WHEN ${held} THEN reserved_credits ELSE 0 END`;
const currentPeriod="c.status='active' AND p.period_start<=? AND p.period_end>? AND NOT EXISTS(SELECT 1 FROM aaro_payment_holds h WHERE h.invoice_id=p.invoice_id)";
const timestamp=()=>new Date().toISOString();
async function owned(owner:string,id:string){const record=await database().prepare('SELECT * FROM aaro_usage_requests WHERE user_id=? AND id=?').bind(owner,id).first<AaroUsageRecord>();if(!record)throw new RequestError('Usage request not found.',404);return record;}

export async function aaroUsageTotals(owner:string){
 const now=Math.floor(Date.now()/1000);
 const result=await database().prepare(`SELECT COALESCE(SUM(p.credits),0) allocated,COALESCE(SUM((SELECT COALESCE(SUM(actual_credits),0) FROM aaro_usage_requests u WHERE u.invoice_id=p.invoice_id)),0) spent,COALESCE(SUM((SELECT COALESCE(SUM(reserved_credits),0) FROM aaro_usage_requests u WHERE u.invoice_id=p.invoice_id AND ${held})),0) reserved FROM aaro_credit_periods p JOIN aaro_checkouts c ON c.subscription_id=p.subscription_id AND c.user_id=p.user_id WHERE p.user_id=? AND ${currentPeriod}`).bind(owner,now,now).first<{allocated:number;spent:number;reserved:number}>();
 const totals=result||{allocated:0,spent:0,reserved:0};return {...totals,available:Math.max(0,totals.allocated-totals.spent-totals.reserved)};
}
export async function reserveAaroUsage(owner:string,requestKey:string,payloadHash:string,model:string,maximumCredits:number){
 if(!aaroUsageEnabled())throw new RequestError('AARO credit usage is not activated.',503);
 if(!/^(live|test):supabase:[A-Za-z0-9-]+$/.test(owner)||!/^[-A-Za-z0-9_]{8,128}$/.test(requestKey)||!/^[a-f0-9]{64}$/.test(payloadHash)||typeof model!=='string'||model.length<1||model.length>160)throw new RequestError('Invalid usage request.',400);
 if(integer(maximumCredits)<1)throw new RequestError('A credit reservation is required.',400);
 const db=database(),id=crypto.randomUUID(),now=timestamp(),seconds=Math.floor(Date.now()/1000),expires=new Date(Date.now()+120000).toISOString();
 // Single INSERT predicate prevents racing requests from spending the same units.
 await db.prepare(`INSERT OR IGNORE INTO aaro_usage_requests(id,user_id,invoice_id,request_key,payload_hash,model,tariff_version,state,reserved_credits,created_at,updated_at,expires_at)
 SELECT ?,p.user_id,p.invoice_id,?,?,?,?,'reserved',?,?,?,? FROM aaro_credit_periods p JOIN aaro_checkouts c ON c.subscription_id=p.subscription_id AND c.user_id=p.user_id
 WHERE p.user_id=? AND ${currentPeriod} AND ?<=p.credits-COALESCE((SELECT SUM(${used}) FROM aaro_usage_requests WHERE invoice_id=p.invoice_id),0)
 AND (SELECT COUNT(*) FROM aaro_usage_requests WHERE user_id=? AND ${held})<2
 ORDER BY p.period_end,p.invoice_id LIMIT 1`).bind(id,requestKey,payloadHash,model,AARO_TARIFF_VERSION,maximumCredits,now,now,expires,owner,seconds,seconds,maximumCredits,owner).run();
 const record=await db.prepare('SELECT * FROM aaro_usage_requests WHERE user_id=? AND request_key=?').bind(owner,requestKey).first<AaroUsageRecord>();
 if(!record)throw new RequestError('Your active AARO credits or concurrent request limit are insufficient.',402);
 if(record.payload_hash!==payloadHash||record.model!==model||record.reserved_credits!==maximumCredits||record.tariff_version!==AARO_TARIFF_VERSION)throw new RequestError('This request key was already used for different work.',409);
 return {record,fresh:record.id===id};
}
export async function claimAaroUsage(owner:string,id:string){
 if(!aaroUsageEnabled())throw new RequestError('AARO credit usage is not activated.',503);
 const now=timestamp(),seconds=Math.floor(Date.now()/1000);
 return database().prepare(`UPDATE aaro_usage_requests SET state='executing',updated_at=? WHERE id=? AND user_id=? AND state='reserved' AND expires_at>? AND EXISTS(SELECT 1 FROM aaro_credit_periods p JOIN aaro_checkouts c ON c.subscription_id=p.subscription_id AND c.user_id=p.user_id WHERE p.invoice_id=aaro_usage_requests.invoice_id AND p.user_id=? AND ${currentPeriod}) RETURNING *`).bind(now,id,owner,now,owner,seconds,seconds).first<AaroUsageRecord>();
}
export async function settleAaroUsage(owner:string,id:string,settlement:{state:'succeeded'|'failed';inputTokens?:number;outputTokens?:number}){
 if(!settlement||!['succeeded','failed'].includes(settlement.state))throw new RequestError('Invalid settlement.',400);
 if(settlement.state==='succeeded'&&(settlement.inputTokens===undefined||settlement.outputTokens===undefined))throw new RequestError('Confirmed token usage is required.',400);
 const record=await owned(owner,id),input=integer(settlement.inputTokens??0),output=integer(settlement.outputTokens??0);
 const actual=settlement.state==='succeeded'?aaroCredits(input,output):0;
 if(settlement.state==='succeeded'&&actual===0)throw new RequestError('Confirmed token usage is required.',400);
 if(actual>record.reserved_credits)throw new RequestError('Actual usage exceeds the reservation and needs review.',409);
 if(['succeeded','failed'].includes(record.state)){
  if(record.state===settlement.state&&record.actual_credits===actual&&record.input_tokens===input&&record.output_tokens===output)return record;
  throw new RequestError('This usage request has already been settled.',409);
 }
 // A known failure before dispatch can release a reservation. Successful work must be claimed first.
 const allowed=settlement.state==='failed'?"('reserved','executing','uncertain')":"('executing','uncertain')";
 await database().prepare(`UPDATE aaro_usage_requests SET state=?,actual_credits=?,input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND user_id=? AND state IN ${allowed}`).bind(settlement.state,actual,input,output,timestamp(),id,owner).run();
 const final=await owned(owner,id);
 if(final.state!==settlement.state||final.actual_credits!==actual||final.input_tokens!==input||final.output_tokens!==output)throw new RequestError('The usage request changed before settlement.',409);
 return final;
}
export async function uncertainAaroUsage(owner:string,id:string){
 await owned(owner,id);
 await database().prepare("UPDATE aaro_usage_requests SET state='uncertain',updated_at=? WHERE id=? AND user_id=? AND state='executing'").bind(timestamp(),id,owner).run();
 return owned(owner,id);
}
export async function maintainAaroUsage(){
 const now=timestamp(),stale=new Date(Date.now()-300000).toISOString();
 await database().batch([
  database().prepare("UPDATE aaro_usage_requests SET state='cancelled',updated_at=? WHERE id IN (SELECT id FROM aaro_usage_requests WHERE state='reserved' AND expires_at<? LIMIT 200)").bind(now,now),
  database().prepare("UPDATE aaro_usage_requests SET state='uncertain',updated_at=? WHERE id IN (SELECT id FROM aaro_usage_requests WHERE state='executing' AND updated_at<? LIMIT 200)").bind(now,stale),
 ]);
}

import {database,RequestError} from '@/db/service';
import {rateVersion,type Capability} from '@/lib/gateway-catalog';
import type {GatewayIdentity} from '@/lib/gateway-auth';
export type ProviderCosts={together:number;you:number;deepgram:number};
export type GatewayRecord={id:string;user_id:string;key_id:string|null;request_key:string;payload_hash:string;capability:Capability;model:string;rate_version:string;state:string;reserved_micros:number;cost_micros:number;together_reserved:number;you_reserved:number;deepgram_reserved:number;result_json:string|null;error_code:string|null;created_at:string;updated_at:string;usage_json:string};
const held="state IN ('reserved','executing','uncertain')";
const spent=`cost_micros+CASE WHEN ${held} THEN reserved_micros ELSE 0 END`;
const disputeSql=`COALESCE((SELECT SUM(MAX(0,MIN(d.amount_cents,o.amount_cents+COALESCE((SELECT SUM(l.amount_cents) FROM credit_ledger l WHERE l.order_id=o.id AND l.amount_cents<0),0)))) FROM billing_disputes d JOIN billing_orders o ON o.id=d.order_id WHERE d.user_id=? AND d.status IN ('needs_response','under_review','lost')),0)*10000`;
export async function ensureGatewayAccount(owner:string){await database().prepare('INSERT OR IGNORE INTO gateway_accounts(user_id,updated_at) VALUES(?,?)').bind(owner,new Date().toISOString()).run();}
export async function gatewayBalance(owner:string){
 const r=await database().prepare(`SELECT COALESCE((SELECT SUM(amount_cents) FROM credit_ledger WHERE user_id=? AND currency='usd'),0)*10000 funded,COALESCE((SELECT SUM(cost_micros) FROM gateway_requests WHERE user_id=?),0) spent,COALESCE((SELECT SUM(reserved_micros) FROM gateway_requests WHERE user_id=? AND ${held}),0) reserved,${disputeSql} disputed`).bind(owner,owner,owner,owner).first<{funded:number;spent:number;reserved:number;disputed:number}>();
 const v=r!;const remaining=v.funded-v.spent-v.reserved-v.disputed;return {...v,available:Math.max(0,remaining),shortfall:Math.max(0,-remaining)};
}
export async function reserveGateway(user:GatewayIdentity,requestKey:string,payloadHash:string,mode:Capability,model:string,limits:ProviderCosts,caps:ProviderCosts){
 const db=database(),now=new Date().toISOString(),day=now.slice(0,10),minute=new Date(Date.now()-60000).toISOString();
 const existing=await db.prepare('SELECT * FROM gateway_requests WHERE user_id=? AND request_key=?').bind(user.owner,requestKey).first<GatewayRecord>();
 if(existing){if(user.keyId&&existing.key_id!==user.keyId)throw new RequestError('This request belongs to a different API key.',403);if(existing.payload_hash!==payloadHash)throw new RequestError('This idempotency key was already used for a different request.',409);return {record:existing,fresh:false};}
 await ensureGatewayAccount(user.owner);
 for(const v of [...Object.values(limits),...Object.values(caps)])if(!Number.isSafeInteger(v)||v<0||v>1e9)throw new RequestError('Invalid provider spending limit.',400);
 const reserved=limits.together+limits.you+limits.deepgram;
 if(!Number.isSafeInteger(reserved)||reserved<=0)throw new RequestError('A valid spending estimate is required.',400);
 const id=crypto.randomUUID(),expiry=new Date(Date.now()+120000).toISOString();
 const keyCheck=user.keyId?`AND EXISTS(SELECT 1 FROM gateway_keys k WHERE k.id=? AND k.user_id=? AND k.revoked_at IS NULL AND k.expires_at>? AND EXISTS(SELECT 1 FROM json_each(k.scopes) WHERE value=?) AND k.total_limit_micros>=?+COALESCE((SELECT SUM(${spent}) FROM gateway_requests WHERE key_id=k.id),0) AND k.daily_limit_micros>=?+COALESCE((SELECT SUM(${spent}) FROM gateway_requests WHERE key_id=k.id AND (updated_at>=? OR ${held})),0))`:'';
 const providers=(Object.keys(limits) as (keyof ProviderCosts)[]).filter(p=>limits[p]>0);
 const providerChecks=providers.map(p=>`AND ?+COALESCE((SELECT SUM(CASE WHEN ${held} THEN MAX(${p}_reserved,${p}_cost) ELSE ${p}_cost END) FROM gateway_requests WHERE user_id LIKE 'live:%' AND (updated_at>=? OR ${held})),0)<=?`).join(' ');
 const sql=`INSERT OR IGNORE INTO gateway_requests(id,user_id,key_id,request_key,payload_hash,capability,model,rate_version,state,reserved_micros,together_reserved,you_reserved,deepgram_reserved,created_at,updated_at,expires_at)
 SELECT ?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?,?
 WHERE ?<=COALESCE((SELECT SUM(amount_cents)*10000 FROM credit_ledger WHERE user_id=? AND currency='usd'),0)-COALESCE((SELECT SUM(${spent}) FROM gateway_requests WHERE user_id=?),0)-${disputeSql}
 AND EXISTS(SELECT 1 FROM gateway_accounts WHERE user_id=? AND suspended=0 AND daily_limit_micros>=?+COALESCE((SELECT SUM(${spent}) FROM gateway_requests WHERE user_id=? AND (updated_at>=? OR ${held})),0))
 AND (SELECT COUNT(*) FROM gateway_requests WHERE user_id=? AND ${held})<2
 AND (SELECT COUNT(*) FROM gateway_requests WHERE user_id=? AND created_at>?)<20
 AND NOT EXISTS(SELECT 1 FROM gateway_requests WHERE error_code='pricing_bound_exceeded' AND rate_version=?) ${keyCheck} ${providerChecks}`;
 const args:unknown[]=[id,user.owner,user.keyId,requestKey,payloadHash,mode,model,rateVersion,reserved,limits.together,limits.you,limits.deepgram,now,now,expiry,reserved,user.owner,user.owner,user.owner,user.owner,reserved,user.owner,day,user.owner,user.owner,minute,rateVersion];
 if(user.keyId)args.push(user.keyId,user.owner,now,mode,reserved,reserved,day);
 for(const p of providers)args.push(limits[p],day,caps[p]);
 await db.prepare(sql).bind(...args).run();
 const record=await db.prepare('SELECT * FROM gateway_requests WHERE user_id=? AND request_key=?').bind(user.owner,requestKey).first<GatewayRecord>();
 if(!record)throw new RequestError('Request exceeds an available balance, spending limit or concurrency limit. Check usage and try again later.',429);
 if(user.keyId&&record.key_id!==user.keyId)throw new RequestError('This request belongs to a different API key.',403);
 if(record.payload_hash!==payloadHash)throw new RequestError('This idempotency key was already used for a different request.',409);
 return {record,fresh:record.id===id};
}
export async function claimGateway(id:string){return database().prepare("UPDATE gateway_requests SET state='executing',updated_at=? WHERE id=? AND state='reserved' AND expires_at>? RETURNING id").bind(new Date().toISOString(),id,new Date().toISOString()).first();}
export async function progressGateway(id:string,cost:ProviderCosts,usage:unknown){await database().prepare("UPDATE gateway_requests SET together_cost=?,you_cost=?,deepgram_cost=?,usage_json=?,updated_at=? WHERE id=? AND state='executing'").bind(cost.together,cost.you,cost.deepgram,JSON.stringify(usage),new Date().toISOString(),id).run();}
export async function finishGateway(record:GatewayRecord,cost:ProviderCosts,result:unknown,usage:unknown,errorCode?:string,expectedUpdatedAt?:string){
 for(const v of Object.values(cost))if(!Number.isSafeInteger(v)||v<0)throw new Error('Invalid provider cost');
 const actual=cost.together+cost.you+cost.deepgram,exceeded=actual>record.reserved_micros||cost.together>record.together_reserved||cost.you>record.you_reserved||cost.deepgram>record.deepgram_reserved;
 if(!Number.isSafeInteger(actual)||actual<0)throw new Error('Invalid final cost');
 const charge=errorCode?0:Math.min(actual,record.reserved_micros),now=new Date().toISOString(),payload={transaction_id:record.id,timestamp:record.created_at,event_type:'apiwild.usage',properties:{owner:record.user_id,capability:record.capability,model:record.model,rate_version:record.rate_version,retail_micros:charge,provider_micros:actual,usage}};
 const audio=(result as any)?.audioBase64||(result as any)?.apiwild?.audioBase64;
 const chunks=[];if(typeof audio==='string')for(let at=0;at<audio.length;at+=64000)chunks.push(audio.slice(at,at+64000));
 if(chunks.length>90)throw new Error('Audio cache exceeded its bound');
 const committed=await database().batch([
  database().prepare("UPDATE gateway_requests SET state=?,cost_micros=?,together_cost=?,you_cost=?,deepgram_cost=?,result_json=?,usage_json=?,error_code=?,updated_at=? WHERE id=? AND state IN ('executing','uncertain') AND (? IS NULL OR updated_at=?)").bind(errorCode?'failed':'succeeded',charge,cost.together,cost.you,cost.deepgram,JSON.stringify(result, (key,value)=>key==='audioBase64'?undefined:value),JSON.stringify(usage),exceeded?'pricing_bound_exceeded':errorCode||null,now,record.id,expectedUpdatedAt||null,expectedUpdatedAt||null),
  database().prepare("INSERT OR IGNORE INTO gateway_outbox(id,user_id,request_id,payload,created_at) SELECT id,user_id,id,?,? FROM gateway_requests WHERE id=? AND state IN ('succeeded','failed')").bind(JSON.stringify(payload),now,record.id),
  ...chunks.map((chunk,index)=>database().prepare("INSERT OR IGNORE INTO gateway_audio(request_id,chunk_index,content,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM gateway_requests WHERE id=? AND state='succeeded')").bind(record.id,index,chunk,now,record.id))
 ]);
 if(expectedUpdatedAt&&!(committed[0] as any)?.meta?.changes)throw new RequestError('The request changed before resolution. Read its latest state.',409);
 const final=await database().prepare('SELECT state,cost_micros FROM gateway_requests WHERE id=?').bind(record.id).first<{state:string;cost_micros:number}>();
 if(!final||final.state!==(errorCode?'failed':'succeeded')||final.cost_micros!==charge)throw new Error('Settlement did not commit');
 return final.cost_micros;
}
export async function savedGatewayResult(record:{id:string;result_json:string|null;updated_at?:string}){
 if(!record.result_json||record.updated_at&&Date.parse(record.updated_at)<Date.now()-7*86400000)return null;
 const result=JSON.parse(record.result_json),rows=await database().prepare('SELECT content FROM gateway_audio WHERE request_id=? ORDER BY chunk_index').bind(record.id).all<{content:string}>();
 if(rows.results.length){const audio=rows.results.map(r=>r.content).join('');if(result.apiwild)result.apiwild.audioBase64=audio;else result.audioBase64=audio;}
 return result;
}
export async function uncertainGateway(id:string,cost:ProviderCosts,usage:unknown){await database().prepare("UPDATE gateway_requests SET state='uncertain',together_cost=?,you_cost=?,deepgram_cost=?,usage_json=?,error_code='provider_completion_unknown',updated_at=? WHERE id=? AND state='executing'").bind(cost.together,cost.you,cost.deepgram,JSON.stringify(usage),new Date().toISOString(),id).run();}
export async function maintainGateway(){
 const now=new Date().toISOString(),stale=new Date(Date.now()-5*60000).toISOString(),purge=new Date(Date.now()-7*86400000).toISOString();
 await database().batch([
  database().prepare("DELETE FROM gateway_audio WHERE rowid IN (SELECT rowid FROM gateway_audio WHERE created_at<? LIMIT 1000)").bind(purge),
  database().prepare("UPDATE gateway_requests SET state='cancelled',error_code='unsent_expired',updated_at=? WHERE id IN (SELECT id FROM gateway_requests WHERE state='reserved' AND expires_at<? LIMIT 200)").bind(now,now),
  database().prepare("UPDATE gateway_requests SET state='uncertain',error_code='worker_interrupted',updated_at=? WHERE id IN (SELECT id FROM gateway_requests WHERE state='executing' AND updated_at<? LIMIT 200)").bind(now,stale),
  database().prepare("UPDATE gateway_requests SET result_json=NULL WHERE id IN (SELECT id FROM gateway_requests WHERE state IN ('succeeded','failed','cancelled') AND updated_at<? AND result_json IS NOT NULL LIMIT 200)").bind(purge)
 ]);
 return (await database().prepare('SELECT state,COUNT(*) count FROM gateway_requests GROUP BY state').all()).results;
}

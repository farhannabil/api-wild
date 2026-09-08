import {database,respond,RequestError,readTextBounded,trustedWrite} from '@/db/service';
import {gatewayIdentity} from '@/lib/gateway-auth';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner} from '@/lib/billing';
import {publicGatewayConfig} from '@/lib/gateway-config';
import {maintainGateway,savedGatewayResult,gatewayBalance,ensureGatewayAccount} from '@/lib/gateway-ledger';
import {z} from 'zod';
export async function GET(r:Request){try{
 const u=await gatewayIdentity(r);await ensureGatewayAccount(u.owner);await maintainGateway();const db=database();
 const id=new URL(r.url).searchParams.get('id');
 if(id){const event=await db.prepare('SELECT id,capability,model,state,reserved_micros,cost_micros,result_json,error_code,created_at,updated_at FROM gateway_requests WHERE id=? AND user_id=? AND (? IS NULL OR key_id=?)').bind(id,u.owner,u.keyId,u.keyId).first<any>();if(!event)return respond({error:'Request not found.'},404);return respond({...event,result:await savedGatewayResult(event),result_json:undefined});}
 const [balance,account,events]=await Promise.all([gatewayBalance(u.owner),db.prepare('SELECT daily_limit_micros,suspended FROM gateway_accounts WHERE user_id=?').bind(u.owner).first(),db.prepare('SELECT id,capability,model,state,reserved_micros,cost_micros,usage_json,error_code,created_at,updated_at FROM gateway_requests WHERE user_id=? AND (? IS NULL OR key_id=?) ORDER BY created_at DESC LIMIT 100').bind(u.owner,u.keyId,u.keyId).all()]);
 return respond({balance,account,events:events.results,config:publicGatewayConfig()});
 }catch(e){return respond({error:e instanceof RequestError?e.message:'Usage could not be loaded.'},e instanceof RequestError?e.status:503);}}
export async function PATCH(r:Request){try{if(!trustedWrite(r))throw new RequestError('Invalid request origin.',403);const u=await billingIdentity(r,true),owner=billingOwner(u.id);const body=z.object({dailyLimitDollars:z.number().min(0).max(1000)}).strict().safeParse(JSON.parse(await readTextBounded(r,1000)));if(!body.success)throw new RequestError('Choose a daily limit from $0 to $1,000.',400);await ensureGatewayAccount(owner);await database().prepare('UPDATE gateway_accounts SET daily_limit_micros=?,updated_at=? WHERE user_id=?').bind(Math.round(body.data.dailyLimitDollars*1e6),new Date().toISOString(),owner).run();return respond({saved:true});}catch(e){return respond({error:e instanceof RequestError?e.message:'Spending limit could not be saved.'},e instanceof RequestError?e.status:400);}}

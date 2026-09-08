import {billingIdentity} from '@/lib/billing-auth';
import {billingConfig,billingOwner} from '@/lib/billing';
import {database,RequestError} from '@/db/service';
import {hashKey} from '@/lib/key-auth';
import type {Capability} from '@/lib/gateway-catalog';
export type GatewayIdentity={owner:string;keyId:string|null};
export async function gatewayIdentity(r:Request,capability?:Capability):Promise<GatewayIdentity>{
 const token=r.headers.get('authorization')?.replace(/^Bearer /,'')||'';
 if(token.startsWith('aw_')){
  if(!/^aw_(live|test)_[a-f0-9]{64}$/.test(token))throw new RequestError('Invalid API WILD key.',401);
  const now=new Date().toISOString();
  const key=await database().prepare('SELECT id,user_id,scopes FROM gateway_keys WHERE hash=? AND revoked_at IS NULL AND expires_at>?').bind(await hashKey(token),now).first<{id:string;user_id:string;scopes:string}>();
  if(!key||!key.user_id.startsWith(billingConfig().mode+':'))throw new RequestError('This key is expired, revoked or belongs to another billing mode.',401);
  if(capability&&!JSON.parse(key.scopes).includes(capability))throw new RequestError('This key does not allow that capability.',403);
  return {owner:key.user_id,keyId:key.id};
 }
 const user=await billingIdentity(r,true);return {owner:billingOwner(user.id),keyId:null};
}
export function gatewayOrigin(r:Request){const origin=r.headers.get('origin');if(origin&&origin!==new URL(r.url).origin)throw new RequestError('This browser origin is not allowed. Call the API from your server.',403);}

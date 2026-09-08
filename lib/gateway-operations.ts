import {env} from 'cloudflare:workers';
import {hashKey} from '@/lib/key-auth';
import {RequestError} from '@/db/service';
export async function gatewayOperator(r:Request){
 if(!env.GATEWAY_OPERATIONS_SECRET)throw new RequestError('Gateway operations are not configured.',503);
 const token=r.headers.get('authorization')?.replace(/^Bearer /,'')||'';
 if(!token||token.length>256||await hashKey(token)!==await hashKey(env.GATEWAY_OPERATIONS_SECRET))throw new RequestError('Unauthorized.',401);
}

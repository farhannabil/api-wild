import {GET as gatewayUsage} from '@/app/api/gateway/route';
import {keyIdentity} from '@/lib/key-auth';
import {usageResponse} from '@/lib/usage';
import {respond} from '@/db/service';
export async function GET(r:Request){try{if(r.headers.get('authorization')?.startsWith('Bearer aw_'))return gatewayUsage(r);const u=await keyIdentity(r);if(!u)return respond({error:'Invalid, expired or revoked API key.'},401);return await usageResponse(u.id,r);}catch{return respond({error:'Service unavailable.'},503);}}

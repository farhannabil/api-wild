import {keyIdentity} from '@/lib/key-auth';
import {usageResponse} from '@/lib/usage';
import {respond} from '@/db/service';
export async function GET(r:Request){try{const u=await keyIdentity(r);if(!u)return respond({error:'Invalid, expired or revoked API key.'},401);return await usageResponse(u.id,r);}catch{return respond({error:'Service unavailable.'},503);}}

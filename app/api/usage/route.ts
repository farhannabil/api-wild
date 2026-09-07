import {identity,respond} from '@/db/service';
import {usageResponse} from '@/lib/usage';
export async function GET(r:Request){const u=identity(r);if(!u)return respond({error:'Sign in to see usage.'},401);try{return await usageResponse(u.id,r);}catch{return respond({error:'Usage could not be loaded.'},503);}}

import {respond,trustedWrite,readTextBounded,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner,reconcileSession} from '@/lib/billing';
export async function POST(r:Request){if(!trustedWrite(r))return respond({error:'Invalid request origin.'},403);try{const u=await billingIdentity(r);const p=JSON.parse(await readTextBounded(r,2000));if(typeof p.sessionId!=='string')throw new RequestError('Invalid session.',400);return respond(await reconcileSession(p.sessionId,billingOwner(u.id)));}catch(e){return respond({error:e instanceof RequestError?e.message:'Payment confirmation is unavailable. Your balance has not been changed.'},e instanceof RequestError?e.status:503);}}

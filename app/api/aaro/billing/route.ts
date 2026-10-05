import {respond,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner} from '@/lib/billing';
import {aaroStatus} from '@/lib/aaro-billing';
export async function GET(r:Request){try{const u=await billingIdentity(r);return respond(await aaroStatus(billingOwner(u.id)));}catch(e){return respond({error:e instanceof RequestError?e.message:'Billing unavailable.'},e instanceof RequestError?e.status:503);}}

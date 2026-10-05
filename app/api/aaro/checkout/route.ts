import {respond,RequestError,trustedWrite,readTextBounded} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner} from '@/lib/billing';
import {aaroCheckout} from '@/lib/aaro-billing';
export async function POST(r:Request){
 if(!trustedWrite(r))return respond({error:'Invalid request origin.'},403);
 // Consumer AARO subscriptions need a verified account, not API WILD's enterprise onboarding.
 try{const u=await billingIdentity(r),body=JSON.parse(await readTextBounded(r,1000));if(!body||typeof body.plan!=='string')throw new RequestError('Choose a plan.',400);return respond(await aaroCheckout({...u,id:billingOwner(u.id)},body.plan,body.returnTo));}
 catch(e){return respond({error:e instanceof RequestError?e.message:'Checkout unavailable. No charge was made.'},e instanceof RequestError?e.status:e instanceof SyntaxError?400:503);}
}

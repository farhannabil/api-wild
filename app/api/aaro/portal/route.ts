import {database,respond,trustedWrite,RequestError,readTextBounded} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner,stripe} from '@/lib/billing';
import {aaroConfig,aaroReturnUrl} from '@/lib/aaro-billing';
import portals from '@/lib/brand-portals.json';
export async function POST(r:Request){
 if(!trustedWrite(r))return respond({error:'Invalid request origin.'},403);
 try{
  const u=await billingIdentity(r),config=aaroConfig();
  const body=JSON.parse(await readTextBounded(r,1000));
  const row=await database().prepare('SELECT customer_id FROM aaro_checkouts WHERE user_id=? AND subscription_id IS NOT NULL ORDER BY created_at DESC LIMIT 1').bind(billingOwner(u.id)).first<{customer_id:string}>();
  if(!row?.customer_id)throw new RequestError('No AARO subscription yet.',409);
  if(config.mode==='live'&&(await stripe('account')).id!==portals.account)throw new RequestError('Billing connection needs attention.',503);
  const configuration=config.mode==='live'?portals.aaro:config.portal;
  if(!configuration)throw new RequestError('Billing portal is not configured.',503);
  const session=await stripe('billing_portal/sessions',new URLSearchParams({customer:row.customer_id,configuration,return_url:aaroReturnUrl(config.origin,body?.returnTo)}));
  if(typeof session.url!=='string'||new URL(session.url).origin!=='https://billing.stripe.com')throw new RequestError('Billing portal unavailable.',502);
  return respond({url:session.url});
 }catch(e){return respond({error:e instanceof RequestError?e.message:'Billing portal unavailable.'},e instanceof RequestError?e.status:503);}
}

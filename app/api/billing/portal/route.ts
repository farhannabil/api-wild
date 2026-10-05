import {database,respond,trustedWrite,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingConfig,billingOwner,stripe} from '@/lib/billing';
import portals from '@/lib/brand-portals.json';
export async function POST(r:Request){
  if(!trustedWrite(r))return respond({error:'Invalid request origin.'},403);
  try{
    const u=await billingIdentity(r),config=billingConfig();
    if(!config.portal)throw new RequestError('Billing self-service is not available yet.',503);
    if(config.mode==='live'&&(await stripe('account')).id!==portals.account)throw new RequestError('Billing connection needs attention.',503);
    const customer=await database().prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id=?').bind(billingOwner(u.id)).first<{stripe_customer_id:string}>();
    if(!customer?.stripe_customer_id)throw new RequestError('No billing account yet. Complete your first purchase to manage invoices.',409);
    const session=await stripe('billing_portal/sessions',new URLSearchParams({customer:customer.stripe_customer_id,configuration:config.mode==='live'?portals.apiwild:config.portal,return_url:config.origin+'/console/billing'}));
    if(typeof session.url!=='string'||new URL(session.url).origin!=='https://billing.stripe.com')throw new RequestError('Billing portal is unavailable.',502);
    return respond({url:session.url});
  }catch(e){return respond({error:e instanceof RequestError?e.message:'Billing portal could not be opened.'},e instanceof RequestError?e.status:503);}
}

import {database,respond,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner,stripe} from '@/lib/billing';
export async function GET(r:Request){try{
  const u=await billingIdentity(r),id=new URL(r.url).searchParams.get('orderId');
  const order=await database().prepare('SELECT payment_intent FROM billing_orders WHERE id=? AND user_id=?').bind(id,billingOwner(u.id)).first<{payment_intent:string|null}>();
  if(!order?.payment_intent)throw new RequestError('Receipt not found.',404);
  const intent=await stripe('payment_intents/'+encodeURIComponent(order.payment_intent)+'?expand[]=latest_charge');
  const url=intent.latest_charge?.receipt_url;
  if(typeof url!=='string'||new URL(url).origin!=='https://pay.stripe.com')throw new RequestError('Your receipt is not available yet.',409);
  return respond({url});
}catch(e){return respond({error:e instanceof RequestError?e.message:'Receipt unavailable.'},e instanceof RequestError?e.status:503);}}

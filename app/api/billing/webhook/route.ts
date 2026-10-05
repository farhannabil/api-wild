import {database,respond,readTextBounded,RequestError} from '@/db/service';
import {billingConfig,verifyStripeSignature,reconcileSession,reconcileRefund,reconcileDispute} from '@/lib/billing';
import {reconcileStorefrontEvent} from '@/lib/storefront';
import {reconcileAaroEvent} from '@/lib/aaro-billing';
export async function POST(r:Request){
  const config=billingConfig();
  if(!config.webhook||!config.secret)return respond({error:'Webhook not configured.'},503);
  let eventId='unknown';
  try{
    const raw=await readTextBounded(r,1000000);
    if(!await verifyStripeSignature(raw,r.headers.get('stripe-signature')||'',config.webhook))return respond({error:'Invalid signature.'},400);
    const event=JSON.parse(raw);
    if(typeof event.id!=='string'||!/^evt_[A-Za-z0-9]+$/.test(event.id)||typeof event.type!=='string'||!event.data?.object)return respond({error:'Invalid event.'},400);
    eventId=event.id;
    if(event.livemode!==(config.mode==='live'))return respond({error:'Payment mode mismatch.'},400);
    const db=database();
    if(await db.prepare('SELECT id FROM billing_events WHERE id=?').bind(event.id).first())return respond({received:true});
    await reconcileStorefrontEvent(event);
    await reconcileAaroEvent(event);
    if(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){
      // Ignore unrelated Stripe products; retry our session if webhook races the DB write.
      const orderId=event.data.object.metadata?.order_id;
      if(typeof orderId==='string'&&await db.prepare('SELECT id FROM billing_orders WHERE id=?').bind(orderId).first()){const result=await reconcileSession(event.data.object.id);if(event.type==='checkout.session.async_payment_failed'&&result.status==='pending')await db.prepare("UPDATE billing_orders SET status='failed' WHERE session_id=? AND status IN ('created','checkout')").bind(event.data.object.id).run();}
    }else if(event.type==='charge.refunded')await reconcileRefund(event.data.object);
    else if(['refund.created','refund.updated','refund.failed'].includes(event.type))await reconcileRefund(event.data.object);
    else if(event.type.startsWith('charge.dispute.'))await reconcileDispute(event.data.object.id);
    // Receipt is written only after durable side effects. Retries safely replay unfinished work.
    await db.prepare('INSERT OR IGNORE INTO billing_events(id,type,created_at) VALUES(?,?,?)').bind(event.id,event.type,new Date().toISOString()).run();
    return respond({received:true});
  }catch(e){
    console.error('billing.webhook_failed',{eventId,status:e instanceof RequestError?e.status:503});
    return respond({error:'Webhook processing failed. Retry delivery.'},e instanceof RequestError&&e.status===413?413:503);
  }
}

import {env} from 'cloudflare:workers';
import {database,RequestError} from '@/db/service';
import {billingConfig,customerFor,stripe} from '@/lib/billing';
import catalog from '@/lib/aaro-plans.json';
import {aaroUsageTotals,aaroUsageEnabled,AARO_TARIFF_VERSION} from '@/lib/aaro-usage';

export const aaroPlans=catalog.plans;
export function aaroConfig(){
  const c=billingConfig();
  // Payment acceptance is independent of inference/provider funding and API WILD's gate.
  return {...c,enabled:/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(c.secret)&&c.webhook.startsWith('whsec_')&&/^https:\/\/[^/?#]+$/.test(c.origin)&&env.WEBHOOK_INGRESS_VERIFIED==='true'&&(env as typeof env&{AARO_BILLING_ENABLED?:string}).AARO_BILLING_ENABLED==='true'};
}
const objectId=(v:any):string|undefined=>typeof v==='string'?v:v?.id;
const now=()=>new Date().toISOString();
export async function bangladeshEligible(owner:string){
  return !!await database().prepare("SELECT user_id FROM aaro_region_evidence WHERE user_id=? AND country='BD' AND expires_at>? AND revoked_at IS NULL").bind(owner,now()).first();
}
export function aaroReturnUrl(origin:string,returnTo:unknown){return returnTo==='aaro'?'https://aaroglobal.com/app/':origin+'/aaro/billing';}
export async function aaroCheckout(user:{id:string;email:string},planId:string,returnTo:unknown='apiwild'){
  const c=aaroConfig();if(!c.enabled)throw new RequestError('AARO checkout is not activated yet. No charge was made.',503);
  const plan=aaroPlans.find(p=>p.id===planId);if(!plan)throw new RequestError('Choose an AARO plan.',400);
  if(plan.region==='BD'&&!await bangladeshEligible(user.id))throw new RequestError('Bangladesh pricing requires verified Bangladesh billing evidence.',403);
  if(c.mode==='live'){
    const account=await stripe('account');
    if(account.id!==catalog.account||account.charges_enabled!==true)throw new RequestError('Payment connection needs attention.',503);
  }
  const db=database();
  const recent=await db.prepare('SELECT COUNT(*) n FROM aaro_checkouts WHERE user_id=? AND created_at>?').bind(user.id,new Date(Date.now()-3600e3).toISOString()).first<{n:number}>();
  if((recent?.n||0)>=10)throw new RequestError('Too many checkout attempts. Try again later.',429);
  // A unique active_owner prevents parallel tabs from creating two subscriptions.
  await db.prepare('INSERT OR IGNORE INTO aaro_checkouts(id,user_id,active_owner,plan_id,status,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),user.id,user.id,plan.id,'created',now()).run();
  const order=await db.prepare('SELECT * FROM aaro_checkouts WHERE active_owner=?').bind(user.id).first<any>();
  if(!order)throw new RequestError('Checkout is temporarily unavailable.',503);
  let session=order.session_id?await stripe('checkout/sessions/'+encodeURIComponent(order.session_id)):null;
  if(session?.status==='expired'&&!order.subscription_id){
    await db.prepare("UPDATE aaro_checkouts SET status='expired',active_owner=NULL WHERE id=? AND subscription_id IS NULL").bind(order.id).run();
    throw new RequestError('Checkout expired. Choose your plan again.',409);
  }
  if(order.plan_id!==plan.id)throw new RequestError('You already have another AARO checkout or subscription. Finish it or contact support.',409);
  if(order.subscription_id)throw new RequestError('Your AARO subscription already exists. Manage it from billing.',409);
  if(!session){
    if(Date.now()-Date.parse(order.created_at)>23*3600e3)throw new RequestError('An older checkout needs reconciliation before retrying. Contact support.',409);
    const customer=await customerFor(user);
    await db.prepare('UPDATE aaro_checkouts SET customer_id=? WHERE id=? AND customer_id IS NULL').bind(customer,order.id).run();
    const body=new URLSearchParams({mode:'subscription',customer,client_reference_id:order.id,'metadata[aaro_checkout]':order.id,'subscription_data[metadata][aaro_checkout]':order.id,'line_items[0][quantity]':'1','branding_settings[display_name]':'AARO','billing_address_collection':'required','customer_update[address]':'auto','adaptive_pricing[enabled]':'false',integration_identifier:'aaro-monthly-fqkrwzpm',success_url:c.origin+'/aaro/billing?returned=1',cancel_url:c.origin+'/aaro/billing?cancelled=1','custom_text[submit][message]':'AARO monthly subscription. Renews monthly until cancelled. Payment collected by 2740797 Ontario Inc.'});
    const destination=aaroReturnUrl(c.origin,returnTo);
    body.set('success_url',destination+'?billing=returned');body.set('cancel_url',destination+'?billing=cancelled');
    if(c.mode==='live')body.set('line_items[0][price]',plan.priceId);
    else{
      body.set('line_items[0][price_data][currency]',plan.currency);
      body.set('line_items[0][price_data][unit_amount]',String(plan.amount));
      body.set('line_items[0][price_data][recurring][interval]','month');
      body.set('line_items[0][price_data][product_data][name]','AARO '+plan.name);
      body.set('line_items[0][price_data][tax_behavior]','exclusive');
    }
    if(c.tax)body.set('automatic_tax[enabled]','true');
    session=await stripe('checkout/sessions',body,'aaro-checkout-'+order.id);
    if(typeof session.id!=='string'||!session.id.startsWith('cs_'))throw new RequestError('Invalid checkout response.',502);
    await db.prepare("UPDATE aaro_checkouts SET session_id=?,status='checkout' WHERE id=? AND session_id IS NULL").bind(session.id,order.id).run();
  }
  if(session.status!=='open'||typeof session.url!=='string'||new URL(session.url).origin!=='https://checkout.stripe.com')throw new RequestError('Checkout is already complete or unavailable. Refresh billing.',409);
  return {url:session.url};
}

async function subscriptionRecord(subscriptionId:string){
  const db=database(),sub=await stripe('subscriptions/'+encodeURIComponent(subscriptionId));
  let order=await db.prepare('SELECT * FROM aaro_checkouts WHERE subscription_id=?').bind(subscriptionId).first<any>();
  // Explicit fallback for a subscription webhook arriving before checkout completion.
  if(!order&&typeof sub.metadata?.aaro_checkout==='string')order=await db.prepare('SELECT * FROM aaro_checkouts WHERE id=?').bind(sub.metadata.aaro_checkout).first<any>();
  if(!order)return null;
  const plan=aaroPlans.find(p=>p.id===order.plan_id),item=sub.items?.data?.[0];
  if(!plan||sub.id!==subscriptionId||objectId(sub.customer)!==order.customer_id||sub.livemode!==(aaroConfig().mode==='live')||sub.items?.has_more||sub.items?.data?.length!==1||item.quantity!==1||item.price?.currency!==plan.currency||item.price?.unit_amount!==plan.amount||item.price?.recurring?.interval!=='month'||item.price?.recurring?.interval_count!==1||(aaroConfig().mode==='live'&&item.price.id!==plan.priceId)||(order.subscription_id&&order.subscription_id!==subscriptionId))throw new RequestError('AARO subscription verification failed.',409);
  const ended=['canceled','incomplete_expired'].includes(sub.status);
  // Read current Stripe state; a delayed event cannot resurrect a terminal subscription.
  await db.prepare("UPDATE aaro_checkouts SET subscription_id=?,status=?,active_owner=CASE WHEN ? THEN NULL ELSE active_owner END WHERE id=? AND status NOT IN ('canceled','incomplete_expired')").bind(subscriptionId,sub.status,ended?1:0,order.id).run();
  return {order,plan,sub};
}
async function invoiceRecord(invoiceId:string){
  const invoice=await stripe('invoices/'+encodeURIComponent(invoiceId));
  const subscriptionId=objectId(invoice.parent?.subscription_details?.subscription);
  if(!subscriptionId)return null;
  const binding=await subscriptionRecord(subscriptionId);if(!binding)return null;
  if(invoice.id!==invoiceId||objectId(invoice.customer)!==binding.order.customer_id||invoice.livemode!==(aaroConfig().mode==='live'))throw new RequestError('AARO invoice ownership mismatch.',409);
  return {...binding,invoice};
}
async function reconcileInvoice(id:string){
  const record=await invoiceRecord(id);if(!record)return;
  const {invoice,order,plan,sub}=record;
  if(invoice.status!=='paid'||sub.status!=='active')return;
  const line=invoice.lines?.data?.[0],price=objectId(line?.pricing?.price_details?.price);
  if(!['subscription_create','subscription_cycle'].includes(invoice.billing_reason)||invoice.lines?.has_more||invoice.lines?.data?.length!==1||line?.quantity!==1||line.amount!==plan.amount||invoice.subtotal!==plan.amount||invoice.currency!==plan.currency||invoice.amount_remaining!==0||invoice.amount_paid!==invoice.total||invoice.total<plan.amount||(invoice.total_discount_amounts||[]).some((d:any)=>d.amount!==0)||!Number.isSafeInteger(line.period?.start)||!Number.isSafeInteger(line.period?.end)||line.period.end<=line.period.start||(aaroConfig().mode==='live'&&price!==plan.priceId))throw new RequestError('AARO invoice needs review before credit allocation.',409);
  if(plan.amount>0){
    const payments=await stripe('invoice_payments?invoice='+encodeURIComponent(id)+'&status=paid&limit=100');
    if(payments.has_more||!(payments.data||[]).length||(payments.data||[]).some((p:any)=>p.status!=='paid'||p.currency!==plan.currency||p.livemode!==(aaroConfig().mode==='live')||!Number.isSafeInteger(p.amount_paid)||p.amount_paid<=0||!['payment_intent','charge'].includes(p.payment?.type))||(payments.data||[]).reduce((sum:number,p:any)=>sum+p.amount_paid,0)!==invoice.total)throw new RequestError('Confirmed processor payment required for AARO credits.',409);
  }
  // This ledger holds AARO credit units, never API WILD's USD wallet balance.
  await database().prepare('INSERT OR IGNORE INTO aaro_credit_periods(invoice_id,user_id,subscription_id,plan_id,credits,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,order.user_id,sub.id,plan.id,plan.credits,line.period.start,line.period.end,now()).run();
}
async function holdInvoiceForPayment(paymentIntent:string,reason:string){
  const params=new URLSearchParams({'payment[type]':'payment_intent','payment[payment_intent]':paymentIntent,limit:'100'});
  const payments=await stripe('invoice_payments?'+params);
  if(payments.has_more)throw new RequestError('Payment risk reconciliation needs review.',503);
  for(const payment of payments.data||[]){
    const id=objectId(payment.invoice);if(!id)continue;
    const record=await invoiceRecord(id);if(!record)continue;
    // A risk event arriving before invoice.paid still blocks its later grant.
    await database().prepare('INSERT OR IGNORE INTO aaro_payment_holds(invoice_id,reason,created_at) VALUES(?,?,?)').bind(id,reason,now()).run();
  }
}
export async function reconcileAaroEvent(event:any){
  const o=event.data.object;
  if(event.type.startsWith('customer.subscription.')){await subscriptionRecord(o.id);return;}
  if(['invoice.paid','invoice.payment_failed','invoice.payment_action_required','invoice.voided','invoice.marked_uncollectible'].includes(event.type)){await reconcileInvoice(o.id);return;}
  if(event.type.startsWith('checkout.session.')&&typeof o.metadata?.aaro_checkout==='string'){
    const db=database(),order=await db.prepare('SELECT * FROM aaro_checkouts WHERE id=?').bind(o.metadata.aaro_checkout).first<any>();
    if(!order)return;
    const s=await stripe('checkout/sessions/'+encodeURIComponent(o.id));
    if(s.client_reference_id!==order.id||s.mode!=='subscription'||objectId(s.customer)!==order.customer_id||s.livemode!==(aaroConfig().mode==='live')||(order.session_id&&order.session_id!==s.id))throw new RequestError('AARO checkout verification failed.',409);
    await db.prepare('UPDATE aaro_checkouts SET session_id=? WHERE id=? AND session_id IS NULL').bind(s.id,order.id).run();
    if(s.status==='expired')await db.prepare("UPDATE aaro_checkouts SET status='expired',active_owner=NULL WHERE id=? AND subscription_id IS NULL").bind(order.id).run();
    if(objectId(s.subscription))await subscriptionRecord(objectId(s.subscription)!);
    return;
  }
  if(event.type==='charge.refunded'&&o.amount_refunded>0&&objectId(o.payment_intent))await holdInvoiceForPayment(objectId(o.payment_intent)!,'refund-review');
  if(['refund.created','refund.updated'].includes(event.type)&&o.status==='succeeded'&&objectId(o.payment_intent))await holdInvoiceForPayment(objectId(o.payment_intent)!,'refund-review');
  if(event.type.startsWith('charge.dispute.')&&objectId(o.payment_intent))await holdInvoiceForPayment(objectId(o.payment_intent)!,'dispute-review');
}

export async function aaroStatus(owner:string){
  const db=database(),config=aaroConfig();
  const subscriptions=await db.prepare('SELECT plan_id,status,subscription_id FROM aaro_checkouts WHERE user_id=? ORDER BY created_at DESC LIMIT 10').bind(owner).all();
  const periods=await db.prepare("SELECT p.invoice_id,p.plan_id,p.credits,p.period_start,p.period_end FROM aaro_credit_periods p JOIN aaro_checkouts c ON c.subscription_id=p.subscription_id WHERE p.user_id=? AND c.status='active' AND p.period_start<=? AND p.period_end>? AND NOT EXISTS(SELECT 1 FROM aaro_payment_holds h WHERE h.invoice_id=p.invoice_id)").bind(owner,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)).all();
  return {enabled:config.enabled,usage:await aaroUsageTotals(owner),usageEnabled:aaroUsageEnabled(),tariff:AARO_TARIFF_VERSION,bangladeshEligible:await bangladeshEligible(owner),subscriptions:subscriptions.results,creditPeriods:periods.results,plans:aaroPlans.map(({productId,priceId,...p})=>p)};
}

import {env} from 'cloudflare:workers';
import {database,RequestError} from '@/db/service';
export const packs={starter:2500,builder:10000,scale:25000} as const;
export function billingConfig(){
  const secret=env.STRIPE_SECRET_KEY||'',webhook=env.STRIPE_WEBHOOK_SECRET||'';
  const mode=/^(sk|rk)_live_/.test(secret)?'live':'test';
  const valid=/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secret)&&webhook.startsWith('whsec_');
  const origin=env.SITE_ORIGIN||'https://apiwild.com';
  const originValid=/^https:\/\/[^/?#]+$/.test(origin);
  return {secret,webhook,mode,origin,enabled:valid&&originValid&&env.BILLING_ENABLED==='true'&&env.WEBHOOK_INGRESS_VERIFIED==='true'&&(mode==='test'||env.COMMERCE_READY==='true'),tax:env.STRIPE_AUTOMATIC_TAX==='true',portal:env.STRIPE_PORTAL_CONFIGURATION_ID||''};
}
export function billingOwner(id:string){return billingConfig().mode+':'+id;}
export async function customerFor(user:{id:string;email:string}){
  const db=database(),now=new Date().toISOString();
  await db.prepare('INSERT OR IGNORE INTO billing_customers(user_id,created_at) VALUES(?,?)').bind(user.id,now).run();
  const row=await db.prepare('SELECT stripe_customer_id,created_at FROM billing_customers WHERE user_id=?').bind(user.id).first<{stripe_customer_id:string|null;created_at:string}>();
  if(row?.stripe_customer_id){
    // Keep invoice delivery aligned with the customer's verified account email.
    await stripe('customers/'+encodeURIComponent(row.stripe_customer_id),new URLSearchParams({email:user.email}));
    return row.stripe_customer_id;
  }
  // Do not risk a duplicate customer after Stripe expires its idempotency record.
  if(!row||Date.now()-Date.parse(row.created_at)>23*3600e3)throw new RequestError('Billing account setup needs support. Please contact us.',409);
  const c=await stripe('customers',new URLSearchParams({email:user.email,'metadata[apiwild_user]':user.id}),'apiwild-customer-'+user.id);
  if(typeof c.id!=='string'||!c.id.startsWith('cus_'))throw new RequestError('Billing account could not be created.',502);
  await db.prepare('UPDATE billing_customers SET stripe_customer_id=? WHERE user_id=? AND stripe_customer_id IS NULL').bind(c.id,user.id).run();
  return c.id;
}
export async function billingHold(userId:string){
  const row=await database().prepare(`SELECT COALESCE(SUM(MAX(0,MIN(d.amount_cents,o.amount_cents+COALESCE((SELECT SUM(l.amount_cents) FROM credit_ledger l WHERE l.order_id=o.id AND l.amount_cents<0),0)))),0) cents FROM billing_disputes d JOIN billing_orders o ON o.id=d.order_id WHERE d.user_id=? AND d.status IN ('needs_response','under_review','lost')`).bind(userId).first<{cents:number}>();
  return row?.cents||0;
}
export async function stripe(path:string,body?:URLSearchParams,idempotency?:string){const config=billingConfig();if(!config.secret)throw new RequestError('Payments are not connected yet.',503);const r=await fetch('https://api.stripe.com/v1/'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${config.secret}`,'Stripe-Version':'2026-08-26.dahlia',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idempotency?{'Idempotency-Key':idempotency}:{})},body,signal:AbortSignal.timeout(15000)});const data=await r.json() as Record<string,any>;if(!r.ok)throw new RequestError('Payment provider unavailable. Please retry.',502);return data;}
type Order={id:string;user_id:string;pack:string;amount_cents:number;currency:string;session_id:string|null;status:string};
export async function reconcileSession(sessionId:string,owner?:string){if(!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId))throw new RequestError('Invalid checkout session.',400);const db=database();const order=await db.prepare('SELECT * FROM billing_orders WHERE session_id=?').bind(sessionId).first<Order>();if(!order||owner&&order.user_id!==owner)throw new RequestError('Checkout not found.',404);const s=await stripe('checkout/sessions/'+encodeURIComponent(sessionId));const config=billingConfig();if(s.id!==sessionId||s.mode!=='payment'||s.client_reference_id!==order.id||s.metadata?.order_id!==order.id||(s.amount_subtotal??s.amount_total)!==order.amount_cents||s.amount_total!==order.amount_cents+(s.total_details?.amount_tax||0)||(s.total_details?.amount_discount||0)!==0||s.currency!==order.currency||s.livemode!==/^(sk|rk)_live_/.test(config.secret))throw new RequestError('Payment verification failed.',409);if(s.status==='expired'){await db.prepare("UPDATE billing_orders SET status='expired' WHERE id=? AND status NOT IN ('paid','refunded','partially_refunded')").bind(order.id).run();return {status:'expired'};}if(s.payment_status!=='paid'||s.status!=='complete')return {status:'pending'};if(typeof s.payment_intent!=='string')throw new RequestError('Payment reference missing.',409);const now=new Date().toISOString();await db.batch([db.prepare('INSERT OR IGNORE INTO credit_ledger(id,user_id,source,order_id,amount_cents,currency,description,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),order.user_id,'checkout:'+sessionId,order.id,order.amount_cents,order.currency,'Credit purchase',now),db.prepare("UPDATE billing_orders SET status=CASE WHEN status IN ('refunded','partially_refunded') THEN status ELSE 'paid' END,payment_intent=? WHERE id=?").bind(s.payment_intent,order.id)]);return {status:'paid'};}
export async function reconcileRefund(charge:Record<string,any>){
  if(typeof charge.payment_intent!=='string')return;
  const db=database(),order=await db.prepare('SELECT * FROM billing_orders WHERE payment_intent=?').bind(charge.payment_intent).first<Order>();
  const intent=await stripe('payment_intents/'+encodeURIComponent(charge.payment_intent));
  if(!order){if(intent.metadata?.order_id)throw new RequestError('Original payment must reconcile before its refund. Retry this event.',503);return;}
  if(intent.livemode!==(billingConfig().mode==='live')||intent.currency!==order.currency||intent.metadata?.order_id!==order.id||!Number.isSafeInteger(intent.amount_received)||intent.amount_received<order.amount_cents)throw new RequestError('Refund payment verification failed.',409);
  const refunds=await stripe('refunds?payment_intent='+encodeURIComponent(charge.payment_intent)+'&limit=100');
  if(refunds.has_more)throw new RequestError('Refund reconciliation requires operator review.',503);
  let total=0;
  for(const refund of refunds.data||[]){if(refund.status!=='succeeded')continue;if(refund.currency!==order.currency||!Number.isSafeInteger(refund.amount)||refund.amount<1)throw new RequestError('Refund verification failed.',409);total+=refund.amount;}
  if(total>intent.amount_received)throw new RequestError('Refund exceeds payment.',409);
  // Tax is refunded by Stripe; only the proportional prepaid credit is reversed.
  const target=Math.floor(order.amount_cents*total/intent.amount_received);
  if(!target)return;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO credit_ledger(id,user_id,source,order_id,amount_cents,currency,description,created_at) SELECT ?,?,?,?, -? - COALESCE(SUM(amount_cents),0),?,?,? FROM credit_ledger WHERE order_id=? AND amount_cents<0 HAVING -COALESCE(SUM(amount_cents),0)<?`).bind(crypto.randomUUID(),order.user_id,'refund-total:'+order.id+':'+target,order.id,target,order.currency,'Refund',new Date().toISOString(),order.id,target),
    db.prepare(`UPDATE billing_orders SET status=CASE WHEN (SELECT -COALESCE(SUM(amount_cents),0) FROM credit_ledger WHERE order_id=? AND amount_cents<0)>=amount_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id=?`).bind(order.id,order.id)
  ]);
}
export async function verifyStripeSignature(raw:string,header:string,secret:string,now=Math.floor(Date.now()/1000)){const parts=header.split(',').map(p=>p.split('='));const timestamp=parts.find(p=>p[0]==='t')?.[1];if(!timestamp||!/^\d+$/.test(timestamp)||Math.abs(now-Number(timestamp))>300)return false;const signatures=parts.filter(p=>p[0]==='v1'&&/^[a-f0-9]{64}$/.test(p[1]||'')).map(p=>p[1]);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const expected=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw)));return signatures.some(sig=>{let diff=0;for(let i=0;i<32;i++)diff|=expected[i]^parseInt(sig.slice(i*2,i*2+2),16);return diff===0});}

export async function reconcileDispute(disputeId:string){
  if(!/^dp_[A-Za-z0-9]+$/.test(disputeId))throw new RequestError('Invalid dispute.',400);
  const dispute=await stripe('disputes/'+encodeURIComponent(disputeId));
  if(dispute.livemode!==(billingConfig().mode==='live'))throw new RequestError('Dispute mode mismatch.',409);
  const intent=typeof dispute.payment_intent==='string'?dispute.payment_intent:dispute.payment_intent?.id;
  const order=await database().prepare('SELECT * FROM billing_orders WHERE payment_intent=?').bind(intent||'').first<Order>();
  if(!order){if(intent){const pi=await stripe('payment_intents/'+encodeURIComponent(intent));if(pi.metadata?.order_id)throw new RequestError('Payment reconciliation is pending.',503);}return;}
  if(dispute.currency!==order.currency||!Number.isSafeInteger(dispute.amount)||dispute.amount<1)throw new RequestError('Invalid dispute amount.',409);
  const statuses=['needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented'];
  if(!statuses.includes(dispute.status))throw new RequestError('Unknown dispute status.',503);
  // Terminal outcomes cannot be overwritten by a slower concurrent open-event handler.
  await database().prepare(`INSERT INTO billing_disputes(id,user_id,order_id,status,amount_cents,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount_cents=excluded.amount_cents,updated_at=excluded.updated_at WHERE billing_disputes.status NOT IN ('won','lost','warning_closed','prevented')`).bind(dispute.id,order.user_id,order.id,dispute.status,dispute.amount,new Date().toISOString()).run();
}

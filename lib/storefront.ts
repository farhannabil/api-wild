import {env} from 'cloudflare:workers';
import {database,RequestError} from '@/db/service';
import {billingConfig,stripe} from '@/lib/billing';
import catalog from '@/lib/storefront-catalog.json';

type Item={brand:string;product:string;name:string;months:number;connections:number;amount:number;price:string};
export const storefrontCatalog=catalog as {account:string;brands:Record<string,{name:string;origin:string}>;items:Record<string,Item>};
export function storefrontOrigin(origin:string|null){return !!origin&&Object.values(storefrontCatalog.brands).some(b=>b.origin===origin);}
export function storefrontEnabled(){return env.STOREFRONT_CHECKOUT_ENABLED==='true'&&env.WEBHOOK_INGRESS_VERIFIED==='true'&&billingConfig().mode==='live'&&!!billingConfig().secret&&!!billingConfig().webhook;}

export async function createStorefrontCheckout(input:any,origin:string,ip:string){
 if(!storefrontEnabled())throw new RequestError('Le paiement est momentanément indisponible.',503);
 if(typeof input?.sku!=='string'||typeof input?.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestId))throw new RequestError('Sélection invalide.',400);
 const item=storefrontCatalog.items[input.sku],brand=item&&storefrontCatalog.brands[item.brand];
 if(!item||!brand||brand.origin!==origin)throw new RequestError('Sélection invalide.',400);
 const account=await stripe('account');
 if(account.id!==catalog.account||account.charges_enabled!==true)throw new RequestError('Paiements indisponibles.',503);
 const db=database(),now=new Date().toISOString(),orderId=`store_${input.requestId}`;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip+':'+now.slice(0,10))))).map(v=>v.toString(16).padStart(2,'0')).join('');
 const existing=await db.prepare('SELECT * FROM storefront_orders WHERE id=?').bind(orderId).first<any>();
 if(existing&&(existing.sku!==input.sku||existing.brand!==item.brand))throw new RequestError('Recommencez votre commande.',409);
 if(existing&&Date.now()-Date.parse(existing.created_at)>23*3600e3)throw new RequestError('Cette demande a expiré.',409);
 if(existing?.session_id){const session=await stripe('checkout/sessions/'+existing.session_id);if(session.status!=='open')throw new RequestError('Cette commande est déjà terminée. Consultez votre paiement dans Stripe.',409);return {url:session.url};}
 // The INSERT condition makes the per-day limit atomic across simultaneous requests.
 await db.prepare(`INSERT OR IGNORE INTO storefront_orders(id,brand,sku,amount_cents,currency,status,ip_hash,created_at,updated_at) SELECT ?,?,?,?,'cad','created',?,?,? WHERE (SELECT COUNT(*) FROM storefront_orders WHERE ip_hash=?)<20`).bind(orderId,item.brand,input.sku,item.amount,hash,now,now,hash).run();
 const persisted=await db.prepare('SELECT * FROM storefront_orders WHERE id=?').bind(orderId).first<any>();
 if(!persisted)throw new RequestError('Trop de demandes. Réessayez plus tard.',429);
 if(persisted.sku!==input.sku||persisted.brand!==item.brand)throw new RequestError('Recommencez votre commande.',409);
 const description=`${brand.name} — ${item.name} — ${item.months} mois — ${item.connections} connexion(s)`;
 const params=new URLSearchParams({mode:'payment',integration_identifier:'brandstore_qpkmvzra',client_reference_id:orderId,'line_items[0][price]':item.price,'line_items[0][quantity]':'1','automatic_tax[enabled]':'true','branding_settings[display_name]':brand.name,'metadata[storefront_order_id]':orderId,'metadata[storefront_brand]':item.brand,'metadata[storefront_sku]':input.sku,'payment_intent_data[metadata][storefront_order_id]':orderId,'payment_intent_data[metadata][storefront_brand]':item.brand,'payment_intent_data[metadata][storefront_sku]':input.sku,'payment_intent_data[description]':description,'custom_text[submit][message]':`${description}. Forfait prépayé, sans renouvellement automatique. Activation manuelle après confirmation du paiement. Le paiement est encaissé par 2740797 Ontario Inc.`,success_url:brand.origin+'/?checkout=success',cancel_url:brand.origin+'/?checkout=cancelled#catalog'});
 params.set('adaptive_pricing[enabled]','false');
 params.set('success_url',brand.origin+'/?checkout=success&order_id='+encodeURIComponent(orderId));
 params.set('expires_at',String(Math.floor(Date.parse(persisted.created_at)/1000)+23*3600));
 const s=await stripe('checkout/sessions',params,'storefront-'+orderId);
 if(!s.id||typeof s.url!=='string'||!s.url.startsWith('https://checkout.stripe.com/'))throw new RequestError('Paiement indisponible.',502);
 await db.prepare("UPDATE storefront_orders SET session_id=?,status=CASE WHEN status='created' THEN 'checkout' ELSE status END,updated_at=? WHERE id=?").bind(s.id,now,orderId).run();
 return {url:s.url};
}

// Only signed Stripe events enter here. The Stripe object is fetched again to
// avoid trusting event ordering, browser redirects, or client-provided amounts.
export async function reconcileStorefrontEvent(event:any){
 const db=database(),o=event.data.object,now=new Date().toISOString();
 if(event.type.startsWith('checkout.session.')){
  const id=o.metadata?.storefront_order_id;if(!id)return;
  const order=await db.prepare('SELECT * FROM storefront_orders WHERE id=?').bind(id).first<any>();
  if(!order)throw new RequestError('Order reconciliation pending.',503);
  const s=await stripe('checkout/sessions/'+encodeURIComponent(o.id));
  if(s.livemode!==true||s.mode!=='payment'||s.metadata?.storefront_order_id!==id||s.client_reference_id!==id||s.metadata?.storefront_sku!==order.sku||s.metadata?.storefront_brand!==order.brand||s.currency!=='cad'||s.amount_subtotal!==order.amount_cents||s.amount_total!==order.amount_cents+(s.total_details?.amount_tax||0)||(s.total_details?.amount_discount||0)!==0||(order.session_id&&order.session_id!==s.id))throw new RequestError('Storefront payment mismatch.',409);
  if(s.payment_status==='paid'&&s.status==='complete'&&typeof s.payment_intent==='string'){
   await db.batch([
    db.prepare("UPDATE storefront_orders SET session_id=?,payment_intent=?,status=CASE WHEN status IN ('refunded','partially_refunded','disputed') THEN status ELSE 'paid' END,updated_at=? WHERE id=?").bind(s.id,s.payment_intent,now,id),
    db.prepare("INSERT OR IGNORE INTO storefront_fulfillment(order_id,status,created_at) VALUES(?,'manual_pending',?)").bind(id,now)
   ]);
  }else if(s.status==='expired'||event.type==='checkout.session.async_payment_failed'){
   await db.prepare("UPDATE storefront_orders SET status=?,updated_at=? WHERE id=? AND status IN ('created','checkout')").bind(s.status==='expired'?'expired':'failed',now,id).run();
  }
 }else if(event.type==='charge.refunded'||event.type.startsWith('refund.')||event.type.startsWith('charge.dispute.')){
  const piId=typeof o.payment_intent==='string'?o.payment_intent:o.payment_intent?.id;if(!piId)return;
  const pi=await stripe('payment_intents/'+encodeURIComponent(piId));
  const id=pi.metadata?.storefront_order_id;if(!id)return;
  const order=await db.prepare('SELECT * FROM storefront_orders WHERE id=?').bind(id).first<any>();
  if(!order)throw new RequestError('Order reconciliation pending.',503);
  if(pi.livemode!==true||pi.currency!=='cad'||pi.metadata?.storefront_sku!==order.sku)throw new RequestError('Payment mismatch.',409);
  let state='disputed';
  if(!event.type.startsWith('charge.dispute.')){
   const refunds=await stripe('refunds?payment_intent='+encodeURIComponent(piId)+'&limit=100');
   if(refunds.has_more)throw new RequestError('Refund requires review.',503);
   const refunded=refunds.data.filter((r:any)=>r.status==='succeeded').reduce((sum:number,r:any)=>sum+r.amount,0);
   if(!refunded)return;state=refunded>=pi.amount_received?'refunded':'partially_refunded';
  }
  await db.batch([db.prepare("UPDATE storefront_orders SET status=CASE WHEN status='refunded' THEN status ELSE ? END,payment_intent=?,updated_at=? WHERE id=?").bind(state,piId,now,id),db.prepare("INSERT INTO storefront_fulfillment(order_id,status,created_at) VALUES(?,'review_required',?) ON CONFLICT(order_id) DO UPDATE SET status='review_required'").bind(id,now)]);
 }
}

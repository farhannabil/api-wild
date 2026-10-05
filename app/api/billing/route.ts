import {database,respond,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingConfig,billingOwner,billingHold,packs} from '@/lib/billing';
import {gatewayBalance} from '@/lib/gateway-ledger';
import {creditPacks,fundingModes} from '@/lib/gateway-catalog';
export async function GET(r:Request){try{
  const u=await billingIdentity(r),owner=billingOwner(u.id),db=database(),config=billingConfig();
  const [balance,entries,orders,hold,customer,usage,autoRecharge]=await Promise.all([
    db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM credit_ledger WHERE user_id=? AND currency=?').bind(owner,'usd').first<{cents:number}>(),
    db.prepare('SELECT id,amount_cents,currency,description,created_at FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all(),
    db.prepare('SELECT id,request_id,pack,purchase_mode,amount_cents,currency,status,created_at FROM billing_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all(),
    billingHold(owner),db.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id=?').bind(owner).first<{stripe_customer_id:string|null}>(),gatewayBalance(owner),
    db.prepare('SELECT requested_enabled,threshold_cents,refill_pack,monthly_cap_cents,consent_version,consented_at,status,updated_at FROM billing_auto_recharge WHERE user_id=?').bind(owner).first<Record<string,unknown>>()
  ]);
  return respond({balance,availableCents:usage.available/10000,usage,holdCents:hold,entries:entries.results,orders:orders.results,enabled:config.enabled,portalEnabled:!!config.secret&&!!config.portal&&!!customer?.stripe_customer_id,mode:config.mode,packs,catalog:creditPacks,fundingModes,autoRecharge:autoRecharge||{requested_enabled:0,status:'disabled'},currency:'usd'});
}catch(e){return respond({error:e instanceof RequestError?e.message:'Billing could not be loaded.'},e instanceof RequestError?e.status:503);}}

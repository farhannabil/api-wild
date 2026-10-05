import {database,respond,trustedWrite,readTextBounded,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingOwner} from '@/lib/billing';
import {autoRechargeConsentVersion,autoRechargeRequest} from '@/lib/auto-recharge';

async function owner(r:Request){const identity=await billingIdentity(r,true);return billingOwner(identity.id);}

export async function GET(r:Request){try{
  const userId=await owner(r),row=await database().prepare('SELECT requested_enabled,threshold_cents,refill_pack,monthly_cap_cents,consent_version,consented_at,status,updated_at FROM billing_auto_recharge WHERE user_id=?').bind(userId).first<Record<string,unknown>>();
  return respond({settings:row||{requested_enabled:0,status:'disabled'},active:false,consentVersion:autoRechargeConsentVersion});
}catch(e){return respond({error:e instanceof RequestError?e.message:'Auto-recharge settings could not be loaded.'},e instanceof RequestError?e.status:503);}}

export async function POST(r:Request){
  if(!trustedWrite(r))return respond({error:'Invalid request origin.'},403);
  try{
    const userId=await owner(r),parsed=autoRechargeRequest.safeParse(JSON.parse(await readTextBounded(r,2000)));
    if(!parsed.success)throw new RequestError('Choose valid auto-recharge settings and accept the saved-payment authorization.',400);
    const db=database(),now=new Date().toISOString();
    if(!parsed.data.enabled){
      await db.prepare(`INSERT INTO billing_auto_recharge(user_id,requested_enabled,status,updated_at) VALUES(?,0,'disabled',?) ON CONFLICT(user_id) DO UPDATE SET requested_enabled=0,status='disabled',updated_at=excluded.updated_at`).bind(userId,now).run();
      return respond({settings:{requested_enabled:0,status:'disabled',updated_at:now},active:false});
    }
    const customer=await db.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id=?').bind(userId).first<{stripe_customer_id:string|null}>();
    if(!customer?.stripe_customer_id)throw new RequestError('Set up secure billing details before requesting auto-recharge.',409);
    const value=parsed.data;
    await db.prepare(`INSERT INTO billing_auto_recharge(user_id,requested_enabled,threshold_cents,refill_pack,monthly_cap_cents,consent_version,consented_at,status,updated_at) VALUES(?,1,?,?,?,?,?,'awaiting_saved_payment_method',?) ON CONFLICT(user_id) DO UPDATE SET requested_enabled=1,threshold_cents=excluded.threshold_cents,refill_pack=excluded.refill_pack,monthly_cap_cents=excluded.monthly_cap_cents,consent_version=excluded.consent_version,consented_at=excluded.consented_at,status='awaiting_saved_payment_method',updated_at=excluded.updated_at`).bind(userId,value.thresholdCents,value.refillPack,value.monthlyCapCents,value.consentVersion,now,now).run();
    return respond({settings:{requested_enabled:1,threshold_cents:value.thresholdCents,refill_pack:value.refillPack,monthly_cap_cents:value.monthlyCapCents,consent_version:value.consentVersion,consented_at:now,status:'awaiting_saved_payment_method',updated_at:now},active:false,notice:'Auto-recharge will remain inactive until a saved payment method is independently verified.'});
  }catch(e){return respond({error:e instanceof RequestError?e.message:'Auto-recharge settings could not be saved.'},e instanceof RequestError?e.status:e instanceof SyntaxError?400:503);}
}

// Private owner-bound prepaid offer. Configuration never grants wallet credit.
const policies=new WeakSet();
const OWNER=/^(live|test):supabase:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createTemporaryCreditOfferFromEnv(env={}, {clock=Date.now}={}) {
 const values=[env.APIWILD_TEMP_CREDIT_PRICE_ID,env.APIWILD_TEMP_CREDIT_OWNER_ID,env.APIWILD_TEMP_CREDIT_END_AT];
 if(values.every(value=>value===undefined||value===''))return undefined;
 const [priceId,ownerId,endsAt]=values,now=clock(),end=Date.parse(endsAt);
 if(typeof priceId!=='string'||!/^price_[A-Za-z0-9]+$/.test(priceId)||typeof ownerId!=='string'||!OWNER.test(ownerId)
  ||typeof endsAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(endsAt)
  ||!Number.isSafeInteger(now)||!Number.isFinite(end)||end-now>86400000
  ||new Date(end).toISOString()!==endsAt.replace(/Z$/,endsAt.includes('.')?'Z':'.000Z'))throw Error('temporary_credit_offer_invalid_configuration');
 const canonicalEnd=new Date(end).toISOString();
 const policy=Object.freeze({priceId,ownerId,endsAt:canonicalEnd,read(owner){const current=clock();
  return owner===ownerId&&Number.isSafeInteger(current)&&current<=end-31*60000
   ?Object.freeze({id:'launch-dollar',name:'API WILD $1 credits',priceCents:100,bonusCents:0,totalCreditCents:100,endsAt:canonicalEnd}):null;
 },hasCheckoutWindow(expiresAt){const current=clock();return Number.isSafeInteger(current)&&Date.parse(expiresAt)-current>=31*60000&&Date.parse(expiresAt)<=end;}});
 policies.add(policy);return policy;
}
export const isTemporaryCreditOfferPolicy=value=>policies.has(value);

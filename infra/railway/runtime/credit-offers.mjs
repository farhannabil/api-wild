import {strictObject} from './supabase-gateway-rpc.mjs';
export const CREDIT_PROMOTION_ID='apiwild-credit-packs-v1';
export const CREDIT_PACKS=Object.freeze([
 Object.freeze({id:'smart',name:'SmarT',priceCents:7700,bonusCents:1300}),
 Object.freeze({id:'nerd',name:'NeRD',priceCents:10100,bonusCents:1900}),
 Object.freeze({id:'newton',name:'Newton',priceCents:23400,bonusCents:2600}),
 Object.freeze({id:'alien',name:'Alien',priceCents:34500,bonusCents:5500}),
]);
const policies=new WeakSet();
export const isCreditOfferPolicy=value=>policies.has(value);
const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('Invalid fixed credit promotion.');const canonical=new Date(value).toISOString();if(canonical!==value.replace(/Z$/,value.includes('.')?'Z':'.000Z'))throw Error('Invalid fixed credit promotion.');return canonical;};
export function createCreditOfferPolicy({prices={},startsAt=null,endsAt=null,clock=Date.now}={}){
 strictObject(prices,CREDIT_PACKS.map(pack=>pack.id));
 if(typeof clock!=='function'||Object.keys(prices).length!==4||CREDIT_PACKS.some(pack=>typeof prices[pack.id]!=='string'||!/^price_[A-Za-z0-9]+$/.test(prices[pack.id])))throw Error('Invalid credit package prices.');
 if((startsAt===null)!==(endsAt===null))throw Error('Invalid fixed credit promotion.');
 if(startsAt!==null){startsAt=date(startsAt);endsAt=date(endsAt);if(Date.parse(endsAt)-Date.parse(startsAt)!==(15*86400000+31*60000))throw Error('Credit promotion checkout window must last exactly 15 days.');}
 const closesAt=endsAt===null?null:new Date(Date.parse(endsAt)-31*60000).toISOString();
 const policy=Object.freeze({prices:Object.freeze({...prices}),startsAt,endsAt,checkoutClosesAt:closesAt,read(){
  const now=clock();if(!Number.isSafeInteger(now))throw Error('Invalid promotion clock.');
  const active=startsAt!==null&&now>=Date.parse(startsAt)&&now<Date.parse(closesAt);
  return {authority:'apiwild-owned-billing',currency:'USD',promotion:{id:CREDIT_PROMOTION_ID,startsAt,endsAt,checkoutClosesAt:closesAt,active},packages:CREDIT_PACKS.map(pack=>({...pack,bonusCents:active?pack.bonusCents:0,totalCreditCents:pack.priceCents+(active?pack.bonusCents:0)}))};
 }});policies.add(policy);return policy;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreditOfferPolicy} from '../infra/railway/runtime/credit-offers.mjs';
import {verifiedCreditOffers,promotionalCheckoutRemaining,checkoutStorageKey,checkoutRequest,saveCheckoutOrder,saveFailedCheckoutOrder,clearConfirmedCheckouts} from '../lib/owned-credit-offers.mjs';

const start=Date.parse('2026-10-05T18:00:00.000Z'),cutoff=start+15*86400000,end=cutoff+31*60000;
const prices={smart:'price_SmartFixture',nerd:'price_NerdFixture',newton:'price_NewtonFixture',alien:'price_AlienFixture'};
const offersAt=now=>createCreditOfferPolicy({prices,startsAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString(),clock:()=>now}).read();
function storage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}
const identity={packageId:'smart',promotionId:'apiwild-credit-packs-v1'};

test('actual server offers retain four paid, bonus and total amounts with a fixed fifteen-day checkout cutoff',()=>{
  const verified=verifiedCreditOffers(offersAt(start));
  assert.deepEqual(verified.packages.map(pack=>[pack.name,pack.priceCents,pack.bonusCents,pack.totalCreditCents]),[
    ['SmarT',7700,1300,9000],['NeRD',10100,1900,12000],['Newton',23400,2600,26000],['Alien',34500,5500,40000],
  ]);
  assert.equal(verified.promotion.checkoutClosesAt,new Date(cutoff).toISOString());
  assert.equal(promotionalCheckoutRemaining(verified,start),15*86400000);
  assert.equal(promotionalCheckoutRemaining(verified,cutoff+1),0);
  assert.equal(promotionalCheckoutRemaining(verifiedCreditOffers(offersAt(cutoff)),cutoff),0);
  assert.ok(verifiedCreditOffers(offersAt(cutoff)).packages.every(pack=>pack.bonusCents===0&&pack.totalCreditCents===pack.priceCents));
  assert.ok(verifiedCreditOffers(offersAt(start-1)).packages.every(pack=>pack.bonusCents===0));
});

test('offer validation cannot turn arbitrary prices, incorrect totals, old windows or fake active flags into published bonuses',()=>{
  const valid=offersAt(start),copy=()=>structuredClone(valid);
  for(const alter of [v=>v.authority='unowned',v=>v.currency='CNY',v=>v.packages.pop(),
    v=>v.packages[0].totalCreditCents++,v=>v.packages[0].priceCents=-1,v=>v.packages[0].bonusCents=NaN,
    v=>v.packages[1].id='smart',v=>v.packages[0].name='Invented',
    v=>v.promotion.checkoutClosesAt=new Date(cutoff+86400000).toISOString(),
    v=>v.promotion.endsAt=v.promotion.checkoutClosesAt,v=>v.promotion.endsAt=new Date(end+60000).toISOString(),v=>v.promotion.active=false,
    v=>v.promotion.startsAt=v.promotion.endsAt=v.promotion.checkoutClosesAt=null,
  ]){const value=copy();alter(value);assert.throws(()=>verifiedCreditOffers(value),/could not be verified/);}
});

test('package and custom purchases never share a request identity and failures do not roll a new UUID',()=>{
  const local=storage();let created=0;const create=()=>`checkout-request-0000000${++created}`;
  const first=checkoutRequest(local,identity,create),custom=checkoutRequest(local,{amountCents:7700},create);
  assert.notEqual(first.key,custom.key);
  assert.deepEqual(first.body,{packageId:'smart',requestId:first.requestId});
  assert.deepEqual(custom.body,{amountCents:7700,requestId:custom.requestId});
  assert.deepEqual(checkoutRequest(local,identity,create),first);
  assert.equal(created,2);
  saveCheckoutOrder(local,first,'order-smart');
  assert.equal(checkoutRequest(local,identity,create).requestId,first.requestId);
  const malformedKey=checkoutStorageKey({...identity,packageId:'nerd'});local.setItem(malformedKey,'broken-json');
  assert.throws(()=>checkoutRequest(local,{...identity,packageId:'nerd'},create),/preserved/);
  assert.equal(local.getItem(malformedKey),'broken-json');assert.equal(created,2);
});

test('terminal history clears only the exact matching order, preserving pending, ambiguous and custom requests',()=>{
  const local=storage(),request=checkoutRequest(local,identity,()=> 'checkout-request-smart-0001');saveCheckoutOrder(local,request,'order-smart');
  const custom=checkoutRequest(local,{amountCents:7700},()=> 'checkout-request-custom-0001');saveCheckoutOrder(local,custom,'order-custom');
  for(const order of [{id:'order-smart',status:'pending'}, {id:'different-order',status:'paid'}])clearConfirmedCheckouts(local,[{...order,package_id:'smart',promotion_id:identity.promotionId,amount_cents:7700}],identity.promotionId);
  assert.ok(local.getItem(request.key));
  clearConfirmedCheckouts(local,[{id:'order-smart',status:'paid',package_id:'smart',promotion_id:null,amount_cents:7700}],identity.promotionId);
  assert.equal(local.getItem(request.key),null);
  assert.ok(local.getItem(custom.key));
  assert.equal(checkoutRequest(local,{amountCents:7700},()=>{throw Error('Must reuse');}).requestId,custom.requestId);
  clearConfirmedCheckouts(local,[{id:'order-custom',status:'failed',amount_cents:7700}],identity.promotionId);
  assert.equal(local.getItem(custom.key),null);
});

test('failed sessionless checkout preserves its request until the exact authenticated expired order is confirmed',()=>{
  const local=storage(),request=checkoutRequest(local,identity,()=> 'checkout-request-smart-0001');
  const orderId='12345678-1234-4123-8123-123456789abc';
  for(const data of [{orderId},{orderId,creditsGranted:true},{orderId:'untrusted',creditsGranted:false}]){
    saveFailedCheckoutOrder(local,request,{data});assert.equal(JSON.parse(local.getItem(request.key)).orderId,undefined);
  }
  saveFailedCheckoutOrder(local,request,{data:{orderId,creditsGranted:false}});
  assert.equal(checkoutRequest(local,identity,()=>{throw Error('Must retain failed request');}).requestId,request.requestId);
  clearConfirmedCheckouts(local,[{id:orderId,status:'pending',package_id:'smart',promotion_id:identity.promotionId,amount_cents:7700,session_id:null}],identity.promotionId);
  assert.ok(local.getItem(request.key));
  clearConfirmedCheckouts(local,[{id:orderId,status:'expired',package_id:'smart',promotion_id:identity.promotionId,amount_cents:7700,session_id:null}],identity.promotionId);
  assert.equal(local.getItem(request.key),null);
});

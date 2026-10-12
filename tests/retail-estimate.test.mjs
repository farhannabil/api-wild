import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {retailEstimate} from '../lib/retail-estimate.mjs';
import {createRetailTokenPricing} from '../infra/railway/runtime/retail-token-pricing.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../app/models/public-models.json',import.meta.url)));
test('public estimate matches authoritative runtime settlement for approved standard models',()=>{
 const pricing=createRetailTokenPricing({models:catalog.models,rateVersion:'fixture'});
 for(const m of catalog.models.filter(m=>pricing.models.includes(m.model_name))){
  const p=m.apiwild_selling_price;
  for(const [input,output] of [[0,0],[8,1],[48,42],[193,41],[1000000,1000000],[9999999,128]]){
   assert.equal(retailEstimate(p.input,p.output,input,output),pricing.charge({model:m.model_name,promptTokens:input,completionTokens:output}).costUsdMicros/1000000);
  }
 }
});
test('invalid quantities and rates never produce a financial estimate',()=>{
 for(const n of [-1,0.5,Infinity,NaN,1000000001])assert.throws(()=>retailEstimate(.125,.75,n,1));
 for(const n of [-1,Infinity,NaN,.0000001])assert.throws(()=>retailEstimate(n,.75,1,1));
 assert.equal(retailEstimate(.125,.75,8,1),.000002);
 assert.equal(retailEstimate(.3,1.2,1000000,1000000),1.5);
});

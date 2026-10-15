import test from 'node:test';
import assert from 'node:assert/strict';
import {activityCsv,csvValue,effectiveRate,rateFor,rollupModels} from '../app/console/usage-rates.mjs';

test('published charged rate reconciles integer-micros ledger charge',()=>{
 const catalog={models:[{model_name:'fixture-model',apiwild_selling_price:{approved:true,currency:'USD',unit:'per_million_tokens',input:5,output:25}}]};
 const row={model:'fixture-model',inputTokens:100000,outputTokens:20000,chargedUsdMicros:1000000};
 assert.deepEqual(rateFor(catalog,row.model),{input:5,output:25});
 assert.equal(Math.ceil((row.inputTokens*5+row.outputTokens*25)/1000000*1000000),row.chargedUsdMicros);
 assert.equal(effectiveRate(row),8.333334);
});

test('customer usage ranks top models and reconciles the expandable Other rollup',()=>{
 const models=Array.from({length:7},(_,i)=>({model:`fixture-${i}`,requests:i+1,inputTokens:(i+1)*10,outputTokens:(i+1)*5,cacheReadTokens:i,cacheWriteTokens:i+2,cacheReadKnown:1,cacheWriteKnown:1,chargedUsdMicros:7-i}));
 const result=rollupModels(models);
 assert.deepEqual(result.visible.map(row=>row.model),['fixture-0','fixture-1','fixture-2','fixture-3','fixture-4']);
 assert.equal(result.other.model,'Other (2 models)');
 assert.deepEqual([result.other.requests,result.other.inputTokens,result.other.outputTokens,result.other.cacheReadTokens,result.other.cacheWriteTokens,result.other.cacheReadKnown,result.other.cacheWriteKnown,result.other.chargedUsdMicros],[13,130,65,11,15,2,2,3]);
 assert.deepEqual(result.other.models.map(row=>row.model),['fixture-5','fixture-6']);
 assert.deepEqual(result.all.map(row=>row.model),models.map(row=>row.model));
 assert.equal(result.visible.reduce((sum,row)=>sum+row.chargedUsdMicros,0)+result.other.chargedUsdMicros,models.reduce((sum,row)=>sum+row.chargedUsdMicros,0));
});

test('csv export includes billing rule and exact ledger fields while neutralizing formulas',()=>{
 for(const cell of ['=1+1','+cmd','-2+3','@sum','\t=1'])assert.equal(csvValue(cell),`'${cell}`);
 assert.equal(csvValue('plain model'),'plain model');
 const csv=activityCsv([{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',createdAt:'2026-10-15T00:00:00Z',model:'=evil',state:'succeeded',inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,chargedUsdMicros:10,pending:false}],()=>'0.005000');
 const rows=csv.split('\n');
 assert.equal(rows[0],'# Billing rule: charged customer amount = supplier USD cost × 5; integer micros arithmetic rounded up per request; zero extra fee');
 assert.equal(rows[1],'request id,timestamp,model,state,input tokens,output tokens,cache read tokens,cache write tokens,charged USD micros,charged USD,effective rate');
 assert.ok(rows[2].startsWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,2026-10-15T00:00:00Z,\'=evil,succeeded,1,1,,,10,0.000010,0.005000'));
});

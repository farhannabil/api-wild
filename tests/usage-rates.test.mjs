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

test('non-headline models remain discoverable in Other rollup and full list',()=>{
 const result=rollupModels([{model:'gpt-6-sol',requests:1,chargedUsdMicros:2},{model:'fixture-a',requests:2,chargedUsdMicros:1},{model:'fixture-b',requests:3,chargedUsdMicros:1}]);
 assert.equal(result.other.model,'Other (2 models)');
 assert.equal(result.other.chargedUsdMicros,2);
 assert.deepEqual(result.all.map(row=>row.model),['gpt-6-sol','fixture-a','fixture-b']);
});

test('csv export neutralizes formula-leading values',()=>{
 for(const cell of ['=1+1','+cmd','-2+3','@sum','\t=1'])assert.equal(csvValue(cell),`'${cell}`);
 assert.equal(csvValue('plain model'),'plain model');
 const csv=activityCsv([{createdAt:'2026-10-15T00:00:00Z',model:'=evil',state:'settled',inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,chargedUsdMicros:10,pending:false}],()=>'0.005000');
 assert.ok(csv.split('\n')[1].startsWith('2026-10-15T00:00:00Z,\'=evil,'));
});

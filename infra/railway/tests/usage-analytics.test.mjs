import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeTokenDetails,gatewayTokenDetails,validateUsageDashboard} from '../runtime/usage-analytics.mjs';
test('cache metadata preserves original receipt and distinguishes absent values from zero',()=>{
 const fact={id:1,quota:500000};
 assert.deepEqual(nativeTokenDetails({other:'{}'},fact),{fact,cacheReadTokens:null,cacheWriteTokens:null});
 assert.deepEqual(nativeTokenDetails({other:JSON.stringify({cache_tokens:0,cache_creation_tokens:25})},fact),{fact,cacheReadTokens:0,cacheWriteTokens:25});
 assert.equal(nativeTokenDetails({other:{cache_creation_tokens_5m:20,cache_creation_tokens_1h:30}},fact).cacheWriteTokens,50);
 assert.equal(nativeTokenDetails({other:{cache_tokens:-1,cache_creation_tokens_5m:20}},fact).cacheReadTokens,null);
 assert.equal(nativeTokenDetails({other:{}},fact).fact,fact);assert.deepEqual(fact,{id:1,quota:500000});
 assert.deepEqual(gatewayTokenDetails({prompt_tokens_details:{cached_tokens:800},cache_creation_input_tokens:200}),{cache_read_tokens:800,cache_write_tokens:200});
 assert.deepEqual(gatewayTokenDetails({}),{});
});
test('dashboard transport validates bounded counts and coverage',()=>{
 const totals={requests:1,inputTokens:100,outputTokens:20,cacheReadTokens:0,cacheWriteTokens:0,cacheReadKnown:0,cacheWriteKnown:0,chargedUsdMicros:5000000,pendingRequests:0};
 const v={currency:'USD',windowDays:30,timezone:'UTC',refreshedAt:null,billingCheck:null,days:[],models:[],totals};
 assert.equal(validateUsageDashboard(v),v);
 for(const patch of [{requests:-1},{chargedUsdMicros:Infinity},{cacheReadKnown:2}])assert.throws(()=>validateUsageDashboard({...v,totals:{...totals,...patch}}));
 assert.throws(()=>validateUsageDashboard({...v,days:Array(31).fill({...totals,day:'2026-10-13'})}));
});

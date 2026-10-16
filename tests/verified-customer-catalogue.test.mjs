import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {approvedModelReferences,callableCustomerModels,listedCustomerModels,customerRouteExamples} from '../app/models/callable-catalogue.mjs';

const publicCatalog = JSON.parse(readFileSync(new URL('../app/models/public-models.json', import.meta.url)));
const internalCatalog = JSON.parse(readFileSync(new URL('../data/selected-supplier-models.json', import.meta.url)));
const referenceCatalog = JSON.parse(readFileSync(new URL('../data/models.json', import.meta.url)));
// Exact model identities from the accepted launch routes; no provider aliases are admitted.
const accepted = ['MiniMax-M2.7-highspeed','claude-fable-5','claude-fable-5-1',
  'claude-haiku-4-5','claude-haiku-4-5-20251001','claude-opus-4-6','claude-opus-4-7',
  'claude-opus-4-8','claude-opus-5','claude-opus-5-5','claude-sonnet-4-6','claude-sonnet-5',
  'claude-sonnet-5-5','gemini-3.1-flash-lite','gemini-3.1-pro-preview','gemini-3.8-flash',
  'glm-5.3','gpt-6-astra','gpt-6-sol','grok-4.5','grok-4.7','deepseek-v4.1-flash'];
const row = (id, callable = true) => ({id, callable, capabilities: callable ? ['chat','code','research'] : []});
const discovery = models => ({schemaVersion:1, authority:'apiwild-owned-runtime', source:'apiwild-approved-retail', count:models.length, models});

test('customer catalogue contains 22 owner-priced identities while the private historical supplier journal is retained', () => {
  assert.equal(publicCatalog.count, 22);
  assert.equal(publicCatalog.models.length, 22);
  assert.deepEqual(publicCatalog.models.map(model => model.model_name).sort(), accepted.slice().sort());
  assert.equal(internalCatalog.count, 40);
  assert.equal(internalCatalog.models.length, 40);
  assert.equal(internalCatalog.models.filter(model => !accepted.includes(model.model_name)).length, 18);
  for (const model of publicCatalog.models) {
    const original = internalCatalog.models.find(item => item.model_name === model.model_name);
    assert.ok(original);
    for (const [key, value] of Object.entries(model)) {if(!['official_reference','billing_note'].includes(key))assert.deepEqual(value, original[key], `${model.model_name}: ${key} changed`);} assert.equal(model.official_reference.currency, 'USD'); assert.equal(model.official_reference.unit, 'per_million_tokens'); assert.match(model.official_reference.checked_date,/^2026-10-(05|12)$/); assert.ok(Number.isFinite(model.official_reference.input)&&model.official_reference.input>=0); assert.ok(Number.isFinite(model.official_reference.output)&&model.official_reference.output>=0); assert.equal(new URL(model.official_reference.source).protocol, 'https:');
  }
});

test('directory excludes false, absent and unknown routes without changing approved prices or source order', () => {
  const [first, second, third] = publicCatalog.models;
  const result = callableCustomerModels(discovery([
    {...row(third.model_name), pricing:{currency:'USD',input:0,output:0}},
    row('unaccepted-provider-alias'), row(second.model_name, false), row(first.model_name),
  ]), publicCatalog.models);
  assert.deepEqual(result, [first, third]);
  assert.equal(result[0], first);
  assert.deepEqual(callableCustomerModels(discovery([]), publicCatalog.models), []);
});

test('listed models take charged pricing only from validated runtime rows and preserve availability',()=>{
 const [first,second,third]=publicCatalog.models,chargedPricing={currency:'USD',unit:'per_million_tokens',input:0.132353,output:0.529412,billingPolicy:'supplier-cost-5x-v1'};
 const approved=[{...first,chargedPricing:{input:999}},second,third];
 const result=listedCustomerModels(discovery([{...row(first.model_name),chargedPricing},row(second.model_name,false),{...row('unknown'),chargedPricing}]),approved);
 assert.deepEqual(result.map(model=>[model.model_name,model.chargedPricing,model.available]),[[first.model_name,chargedPricing,true],[second.model_name,null,false],[third.model_name,null,false]]);
 assert.equal(listedCustomerModels(discovery([row(first.model_name)]),approved)[0].chargedPricing,null);
 assert.throws(()=>listedCustomerModels({authority:'untrusted'},approved),/could not be verified/);
});

test('workspace marketing examples reference only priced accepted customer models', () => {
  assert.deepEqual(customerRouteExamples.map(example => example.id), ['chat','code','research']);
  for (const example of customerRouteExamples) {
    const model = publicCatalog.models.find(item => item.model_name === example.model);
    assert.ok(model, example.model);
    assert.equal(model.apiwild_selling_price.approved, true);
    assert.equal(model.apiwild_selling_price.currency, 'USD');
    assert.ok(Number.isFinite(model.apiwild_selling_price.input));
    assert.ok(Number.isFinite(model.apiwild_selling_price.output));
  }
});

test('directory fails closed for unowned, old, failed and malformed discovery responses', () => {
  const valid = discovery([row(accepted[0])]);
  for (const data of [null, [], {error:'upstream failure'}, {...valid,schemaVersion:0},
    {...valid,authority:'subrouter'}, {...valid,source:'legacy-pricing'}, {...valid,count:2},
    discovery([row(accepted[0]), row(accepted[0])]), discovery([{...row(accepted[0]),callable:'true'}]),
    discovery([{...row(accepted[0]),capabilities:['voice']}]),
    discovery([{...row(accepted[0]),capabilities:[]}]),
    discovery([{...row(accepted[0]),capabilities:['chat','chat']}]),
    discovery([row(' '+accepted[0])]), discovery(Array(2001).fill(row(accepted[0]))),
  ]) assert.throws(() => callableCustomerModels(data, publicCatalog.models), /could not be verified/);
});

test('public price references intersect exact accepted identities and preserve all original rates and fields', () => {
  const references = approvedModelReferences(referenceCatalog.models, publicCatalog.models);
  const approvedIds = new Set(publicCatalog.models.flatMap(model => model.openrouter_reference ? [model.openrouter_reference.model_id] : []));
  assert.equal(referenceCatalog.models.length, 581);
  assert.equal(references.length, 15);
  assert.deepEqual(references, referenceCatalog.models.filter(model => approvedIds.has(model.id)));
  for (const reference of references) assert.equal(reference, referenceCatalog.models.find(model => model.id === reference.id));
  assert.ok(references.some(model => model.id === 'google/gemini-3.1-flash-lite'));
  assert.ok(references.some(model => model.id === 'google/gemini-3.8-flash'));
  const absent = [...approvedIds].filter(id => !references.some(model => model.id === id));
  assert.deepEqual(absent.sort(), ['anthropic/claude-opus-5.5','anthropic/claude-sonnet-5.5','openai/gpt-6-sol','x-ai/grok-4.7']);
});

test('reference filtering never guesses an alias, copies retail prices, or fills missing comparisons', () => {
  const exact = {id:'creator/model-4.5',pricing:{input:0.25,output:2},displayPricing:[]};
  const alias = {id:'creator/model-4-5',pricing:{input:99,output:999}};
  const approved = [{openrouter_reference:{model_id:exact.id,input:0,output:0}},
    {openrouter_reference:{model_id:'creator/missing'}}, {openrouter_reference:null}];
  assert.deepEqual(approvedModelReferences([alias,exact],approved), [exact]);
  assert.deepEqual(approvedModelReferences([exact],[{openrouter_reference:{model_id:'CREATOR/MODEL-4.5'}}]), []);
  assert.deepEqual(approvedModelReferences([exact],[]), []);
  assert.throws(() => approvedModelReferences([exact],[{openrouter_reference:{model_id:' '+exact.id}}]), /Invalid approved/);
});

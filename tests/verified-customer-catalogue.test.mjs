import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {callableCustomerModels,customerRouteExamples} from '../app/models/callable-catalogue.mjs';

const publicCatalog = JSON.parse(readFileSync(new URL('../app/models/public-models.json', import.meta.url)));
const internalCatalog = JSON.parse(readFileSync(new URL('../data/selected-supplier-models.json', import.meta.url)));
// Exact model identities from the accepted launch routes; no provider aliases are admitted.
const accepted = ['MiniMax-M2.7-highspeed','MiniMax-M3','claude-fable-5','claude-fable-5-1',
  'claude-haiku-4-5','claude-haiku-4-5-20251001','claude-opus-4-6','claude-opus-4-7',
  'claude-opus-4-8','claude-opus-5','claude-opus-5-5','claude-sonnet-4-6','claude-sonnet-5',
  'claude-sonnet-5-5','gemini-2.5-flash-lite','gemini-3.1-flash-lite','gemini-3.1-pro-preview',
  'glm-5.1','glm-5.3','glm-5.3-flashx','gpt-6-astra','gpt-6-sol','grok-4.5','grok-4.7'];
const row = (id, callable = true) => ({id, callable, capabilities: callable ? ['chat','code','research'] : []});
const discovery = models => ({schemaVersion:1, authority:'apiwild-owned-runtime', source:'apiwild-approved-retail', count:models.length, models});

test('customer catalogue contains exactly the accepted 24 identities while the internal supplier journal remains 39', () => {
  assert.equal(publicCatalog.count, 24);
  assert.equal(publicCatalog.models.length, 24);
  assert.deepEqual(publicCatalog.models.map(model => model.model_name).sort(), accepted.slice().sort());
  assert.equal(internalCatalog.count, 39);
  assert.equal(internalCatalog.models.length, 39);
  assert.equal(internalCatalog.models.filter(model => !accepted.includes(model.model_name)).length, 15);
  for (const model of publicCatalog.models) {
    const original = internalCatalog.models.find(item => item.model_name === model.model_name);
    assert.ok(original);
    for (const [key, value] of Object.entries(model)) assert.deepEqual(value, original[key], `${model.model_name}: ${key} changed`);
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

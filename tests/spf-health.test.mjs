import test from 'node:test';
import assert from 'node:assert/strict';
import {spfIncludesProvider} from '../scripts/spf-health.mjs';

const resolver = records => async domain => records[domain] || [];
const check = records => spfIncludesProvider('send.example.com','amazonses.com',resolver(records));

test('recognizes direct and registrar-delegated Amazon SES includes', async () => {
  assert.equal(await check({'send.example.com':[['v=spf1 include:amazonses.com ~all']]}), true);
  assert.equal(await check({
    'send.example.com':[['v=spf1 include:dc-example._spfm.send.example.com ~all']],
    'dc-example._spfm.send.example.com':[['v=spf1 include:amazon','ses.com ~all']],
  }), true);
  assert.equal(await check({'send.example.com':[['V=SPF1 +include:AMAZONSES.COM. ~all']]}), true);
});

test('does not accept missing, duplicate, unrelated or non-authorizing includes', async () => {
  for (const records of [[],[['not-spf include:amazonses.com']],[['v=spf1 ~all']],[['v=spf1 include:amazonses.com.evil.example ~all']], [['v=spf1 -include:amazonses.com ~all']], [['v=spf1 ?include:amazonses.com ~all']], [['v=spf1 ~include:amazonses.com ~all']], [['v=spf1 -all include:amazonses.com']], [['v=spf1 include:amazonses.com'],['v=spf1 ~all']]]) {
    assert.equal(await check({'send.example.com':records}), false);
  }
});

test('cycles and excessive lookups fail without unbounded resolution', async () => {
  await assert.rejects(check({'send.example.com':[['v=spf1 include:send.example.com ~all']]}), {code:'SPF_CYCLE'});
  let calls = 0;
  await assert.rejects(spfIncludesProvider('send.example.com','amazonses.com',async () => {
    calls++;
    return [[`v=spf1 include:hop${calls}.example.com ~all`]];
  }), {code:'SPF_LOOKUP_LIMIT'});
  assert.equal(calls, 10);
});

test('DNS failures remain failures instead of reporting healthy', async () => {
  await assert.rejects(spfIncludesProvider('send.example.com','amazonses.com',async () => {
    throw Object.assign(new Error('resolver unavailable'), {code:'ECONNREFUSED'});
  }), {code:'ECONNREFUSED'});
});

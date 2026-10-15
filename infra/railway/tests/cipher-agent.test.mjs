import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {runCipherAgent} from '../run-cipher-agent.mjs';

const env = {CIPHER_AGENT_ENABLED:'true',CIPHER_API_KEY:'cipher-secret-test-key',
  CIPHER_API_BASE_URL:'https://model.example/v1',CIPHER_MODEL:'test-model',
  LINEAR_API_KEY:'linear-secret-test-key',CIPHER_LINEAR_ISSUE_ID:'test-issue'};
const readRepoState = async () => ({log:'abc123 maintenance',status:''});
const report = '## Status\nUnverified readiness.\n## Anomalies\nNone evidenced.\n## Recommended actions\nReview readiness.';
const reply = content => ({ok:true,json:async () => content});

test('disabled worker exits cleanly without reading tasks or fetching', async () => {
  await runCipherAgent({env:{CIPHER_TASK_FILE:'missing.md'},
    fetchImpl:() => assert.fail('disabled fetch'),
    readRepoState:() => assert.fail('disabled git'),log:() => assert.fail('disabled log')});
  const child = spawnSync(process.execPath, ['infra/railway/run-cipher-agent.mjs'], {
    env:{...process.env,CIPHER_AGENT_ENABLED:'false'},encoding:'utf8'
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('missing API key fails closed before any fetch or repository read', async () => {
  await assert.rejects(runCipherAgent({env:{...env,CIPHER_API_KEY:''},
    fetchImpl:() => assert.fail('missing-key fetch'),
    readRepoState:() => assert.fail('missing-key git')}), /configuration missing/);
});

test('model report is posted as a Linear comment with no model tools', async () => {
  const calls = [];
  const logs = [];
  await runCipherAgent({env,readRepoState,log:line => logs.push(line),
    fetchImpl:async (url, options) => {
      calls.push({url,...options,body:JSON.parse(options.body)});
      return calls.length === 1 ? reply({content:[{type:'text',text:report}]}) :
        reply({data:{commentCreate:{success:true}}});
    }});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://model.example/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], env.CIPHER_API_KEY);
  assert.equal(calls[0].body.model, env.CIPHER_MODEL);
  assert.equal(calls[0].body.tools, undefined);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[1].url, 'https://api.linear.app/graphql');
  assert.equal(calls[1].headers.Authorization, env.LINEAR_API_KEY);
  assert.deepEqual(calls[1].body.variables, {issueId:env.CIPHER_LINEAR_ISSUE_ID,body:report});
  assert.deepEqual(logs.map(JSON.parse), [{status:'reported'}]);
});

test('stdout fallback never logs API keys, even if the model echoes them', async () => {
  const logs = [];
  await runCipherAgent({env:{...env,CIPHER_LINEAR_ISSUE_ID:''},readRepoState,
    log:line => logs.push(line),fetchImpl:async () => reply({content:[{type:'text',
      text:`${report}\n${env.CIPHER_API_KEY}\n${env.LINEAR_API_KEY}\nprivate@example.com`}]})});
  assert.equal(logs.length, 1);
  assert.ok(JSON.parse(logs[0]).report.includes('[redacted]'));
  assert.ok(!logs.join('').includes(env.CIPHER_API_KEY));
  assert.ok(!logs.join('').includes(env.LINEAR_API_KEY));
  assert.ok(!logs.join('').includes('private@example.com'));
});

test('model and Linear errors fail closed without exposing response bodies', async () => {
  await assert.rejects(runCipherAgent({env,readRepoState,
    fetchImpl:async () => ({ok:false})}), /model request failed/);
  let calls = 0;
  await assert.rejects(runCipherAgent({env,readRepoState,fetchImpl:async () => {
    calls++;
    return calls === 1 ? reply({content:[{type:'text',text:report}]}) :
      reply({errors:[{message:'private error'}]});
  }}), /Linear comment failed/);
});

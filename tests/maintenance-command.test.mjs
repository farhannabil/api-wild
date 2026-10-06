import test from'node:test';import assert from'node:assert/strict';import{command}from'../scripts/maintenance/controller.mjs';
test('command deadline rejects a late exit-zero and escalates an ignored termination',async()=>{
 const result=await command(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{timeout:100});
 assert.equal(result.code,1);assert.equal(result.timedOut,true);assert.equal(result.bounded,false);
});
test('output limit fails closed even when the child would exit zero',async()=>{
 const result=await command(process.execPath,['-e',"process.stdout.write('x'.repeat(10000));"],{limit:100});
 assert.equal(result.code,1);assert.equal(result.bounded,false);
});

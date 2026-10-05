import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {normalizeChatRequest, chatInputBytes, bufferedChatStream, settledChatCompletion} from '../runtime/chat-compatibility.mjs';
import {createSubrouterDispatch} from '../runtime/subrouter-dispatch.mjs';
import {createGatewayService} from '../runtime/gateway-service.mjs';
import {createGatewayIngress} from '../runtime/gateway-ingress.mjs';
import {createGatewayHttp} from '../runtime/gateway-http.mjs';
import {createCustomerKeyRpc} from '../runtime/customer-key-rpc.mjs';
import {GatewayError, SUPABASE_ORIGIN} from '../runtime/supabase-gateway-rpc.mjs';
const BUDGET='dddddddd-dddd-4ddd-8ddd-dddddddddddd', OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', KEY='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token='aw_test_'+'a'.repeat(64), relay='sk-syntheticNotARealCredential0001';
const tool=()=>({type:'function',function:{name:'lookup_weather',description:'Return a fixture weather report.',strict:true,parameters:{type:'object',properties:{city:{type:'string'}},required:['city'],additionalProperties:false}}});
const call=()=>({id:'call_fixture_1',type:'function',function:{name:'lookup_weather',arguments:'{"city":"Winnipeg"}'}});
const input=()=>({model:'fixture-model',messages:[{role:'user',content:'Weather?'}],max_completion_tokens:64,tools:[tool()],tool_choice:'required',parallel_tool_calls:false});
const route=()=>({providerBudgetId:BUDGET,model:'fixture-model',upstreamModel:'fixture-upstream',rateVersion:'fixture-v1',apiKey:relay,capability:'chat',maxOutputTokens:64,maxInputChars:60000,supportsTools:true});
const provider=()=>({id:'chatcmpl_fixture_1',created:1791200000,model:'fixture-upstream',usage:{prompt_tokens:42,completion_tokens:12,total_tokens:54},choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[call()]},finish_reason:'tool_calls'}]});
const record=()=>({state:'executing',model:'fixture-model',provider_budget_id:BUDGET,rate_version:'fixture-v1',capability:'chat'});
const payload=raw=>({format:'openai',body:normalizeChatRequest(raw).body});
const frameData=text=>text.trim().split('\n\n').map(frame=>frame.replace(/^data: /,'')).map(value=>value==='[DONE]'?value:JSON.parse(value));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('normalizes SDK chat fields while keeping tools inert and the upstream non-streaming',()=>{
  const raw={...input(),stream:true,stream_options:{include_usage:true},n:1};
  const normalized=normalizeChatRequest(raw);assert.equal(normalized.body.max_tokens,64);assert.equal(normalized.body.max_completion_tokens,undefined);
  assert.equal(normalized.body.stream,false);assert.equal(normalized.stream,true);assert.equal(normalized.includeUsage,true);assert.equal(normalized.usesTools,true);
  raw.tools[0].function.name='later_mutation';assert.equal(normalized.body.tools[0].function.name,'lookup_weather');
  assert.ok(chatInputBytes(normalized.body)>Buffer.byteLength(JSON.stringify(normalized.body.messages)));
});

test('complete assistant/tool history is accepted; missing, repeated, orphaned and interleaved results fail',()=>{
  const messages=[{role:'user',content:'Weather?'},{role:'assistant',content:null,tool_calls:[call()]},{role:'tool',tool_call_id:call().id,content:'{"temperature":3}'}];
  assert.equal(normalizeChatRequest({...input(),messages}).body.messages[2].role,'tool');
  for(const history of [messages.slice(0,2),[messages[0],messages[2]],[...messages,messages[2]],[...messages.slice(0,2),{role:'user',content:'next'},messages[2]],
    [...messages,{role:'assistant',tool_calls:[call()]},messages[2]]])assert.throws(()=>normalizeChatRequest({...input(),messages:history}));
  assert.throws(()=>normalizeChatRequest({...input(),messages:[messages[0],{role:'assistant',tool_calls:[{...call(),id:'call_bad?owner=other'}]},messages[2]]}));
});

test('strict schemas, roles, sizes and unsupported features reject before executable getters run',()=>{
  const invalid=[{max_tokens:1},{n:2},{stream:'true'},{stream_options:{include_usage:true}},{tools:[]},
    {tools:[{...tool(),function:{name:'bad.name'}}]}, {tools:[{...tool(),function:{name:'lookup_weather',parameters:null}}]},
    {tools:[{...tool(),function:{name:'lookup_weather',parameters:{type:'object',$ref:'https://example.invalid/schema'}}}]},
    {tools:[{...tool(),function:{name:'lookup_weather',parameters:{type:'object',properties:{x:{type:'string'}},required:['absent']}}}]},
    {tool_choice:{type:'function',function:{name:'undefined_tool'}}},{parallel_tool_calls:'false'},
    {messages:[{role:'function',name:'lookup_weather',content:'x'}]}, {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:x'}}]}]},
    {messages:[{role:'user',content:'x'.repeat(60001)}]}, {tools:Array.from({length:33},tool)}];
  for(const patch of invalid)assert.throws(()=>normalizeChatRequest({...input(),...patch}));
  let reads=0;const getter={...input()};Object.defineProperty(getter,'tools',{enumerable:true,get(){reads++;return [tool()];}});
  assert.throws(()=>normalizeChatRequest(getter));assert.equal(reads,0);
  const executable={...input(),tools:[{type:'function',function:{name:'lookup_weather',parameters:{type:'object'},execute(){reads++;}}}]};
  assert.throws(()=>normalizeChatRequest(executable));assert.equal(reads,0);
});

test('native console contract stays text-only and rejects tools and streaming',()=>{
  assert.equal(normalizeChatRequest({mode:'research',model:'fixture-model',messages:[{role:'user',content:'Explain'}]}, {native:true}).capability,'research');
  for(const raw of [input(),{model:'fixture-model',messages:[{role:'user',content:'Explain'}],stream:true}])assert.throws(()=>normalizeChatRequest(raw,{native:true}));
});

test('tool dispatch carries bounded data once to the fixed relay and returns measured tool usage',async()=>{
  const calls=[];const dispatch=createSubrouterDispatch({routes:[route()],fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(provider());}});
  const result=await dispatch({record:record(),payload:payload(input()),signal:new AbortController().signal});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://subrouter.ai/v1/chat/completions');const sent=JSON.parse(calls[0].init.body);
  assert.equal(sent.stream,false);assert.equal(sent.tools[0].function.name,'lookup_weather');assert.equal(sent.max_tokens,64);assert.equal(sent.model,'fixture-upstream');
  assert.deepEqual(result.toolCalls,[call()]);assert.equal(result.text,null);assert.deepEqual(result.usage,{prompt_tokens:42,completion_tokens:12});assert.equal(result.settlementVerified,false);
});

test('tool capability and complete JSON byte bounds fail before any supplier call',async()=>{
  for(const config of [{...route(),supportsTools:false},{...route(),supportsTools:undefined},{...route(),maxInputChars:100}]){
    let calls=0;const dispatch=createSubrouterDispatch({routes:[config],fetchImpl:async()=>{calls++;return Response.json(provider());}});
    await assert.rejects(dispatch({record:record(),payload:payload(input()),signal:new AbortController().signal}));assert.equal(calls,0);
  }
});

test('malformed provider tools, usage, finish reasons and receipt identities remain ambiguous without retry',async()=>{
  const base=provider(), malformed=[
    {...base,id:'chatcmpl?owner=other'}, {...base,id:'chatcmpl\nforged'}, {...base,usage:{prompt_tokens:42,completion_tokens:12,total_tokens:1}},
    {...base,usage:{prompt_tokens:42,completion_tokens:65}},
    {...base,choices:[{...base.choices[0],finish_reason:'length'}]},
    {...base,choices:[{...base.choices[0],message:{role:'assistant',content:null,tool_calls:[{...call(),function:{name:'other',arguments:'{}'}}]}}]},
    {...base,choices:[{...base.choices[0],message:{role:'assistant',content:null,tool_calls:[{...call(),function:{name:'lookup_weather',arguments:'{"incomplete":'}}]}}]},
    {...base,choices:[{...base.choices[0],message:{role:'assistant',content:null,tool_calls:[call(),{...call(),id:'call_fixture_2'}]}}]},
    {...base,choices:[{message:{role:'assistant',content:'ignored tool requirement'},finish_reason:'stop'}]},
  ];
  for(const value of malformed){let count=0;const dispatch=createSubrouterDispatch({routes:[route()],fetchImpl:async()=>{count++;return Response.json(value);}});
    await assert.rejects(dispatch({record:record(),payload:payload(input()),signal:new AbortController().signal}),error=>error.ambiguous===true);assert.equal(count,1);}
});

function integrated({finishGate,providerValue=provider(),supportsTools=true}={}){
  const events=[],dispatched=deferred();let current,quotes=0;
  const context={customerId:OWNER,billingMode:'test',keyId:KEY};
  const rpc={verifyOwner:async()=>context,verifyKeyOwner:async()=>context,assertReference(){},assertDispatchWindow(){},assertPrivatePayload(){},
    async reserve(_context,quote){events.push('reserve');quotes++;if(current){if(current.payload_hash!==quote.payloadHash)throw new GatewayError('gateway_payload_conflict',409);return {fresh:false,record:current};}
      current={...record(),id:'fixture_request_1',payload_hash:quote.payloadHash,state:'reserved',settlement_reference:null,result_json:null};return {fresh:true,record:current};},
    async claim(){events.push('claim');current={...current,state:'executing'};return {claimed:true,record:current};},
    async finish(_context,_record,receipt){events.push('finish-start');if(finishGate)await finishGate.promise;current={...current,state:'succeeded',settlement_reference:receipt.settlementReference,result_json:receipt.result};events.push('finish-committed');return {settled:true,record:current};},
    async uncertain(){events.push('uncertain');current={...current,state:'uncertain'};return {record:current};}};
  const dispatch=createSubrouterDispatch({routes:[{...route(),supportsTools}],fetchImpl:async()=>{events.push('supplier');dispatched.resolve();return Response.json(providerValue);}});
  const service=createGatewayService({rpc,dispatch,verifySettlement:async({providerResult})=>{events.push('verify');return {state:'succeeded',settlementReference:'usage:'+providerResult.providerResponseId,costUsdMicros:54,costCnyMicros:0,
    result:{...providerResult,model:'fixture-model'},usage:providerResult.usage};}});
  const keys=createCustomerKeyRpc({supabaseOrigin:SUPABASE_ORIGIN,billingMode:'test',secretKey:'sb_secret_syntheticNotReal0000001',verifyOwner:async()=>context,fetchImpl:async()=>{throw Error('No external key transport in fixture.');}});
  const ingress=createGatewayIngress({rpc,keys,service,origin:'https://apiwild.com',enabled:true,selectQuote:async()=>({providerBudgetId:BUDGET,model:'fixture-model',rateVersion:'fixture-v1',reservedUsdMicros:100,reservedCnyMicros:10})});
  const makeRequest=(raw=input(),signal)=>new Request('https://apiwild.com/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'compatibility_fixture_1'},body:JSON.stringify(raw),...(signal?{signal}:{})});
  return {events,dispatched,ingress,makeRequest,get current(){return current;},get quotes(){return quotes;}};
}

test('buffered SSE waits for committed settlement; duplicate and replay cause exactly one supplier dispatch',async()=>{
  const gate=deferred(), f=integrated({finishGate:gate}), raw={...input(),stream:true,stream_options:{include_usage:true}};
  let exposed=false;const first=f.ingress.handle(f.makeRequest(raw)).then(response=>{exposed=true;return response;});await f.dispatched.promise;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(exposed,false);assert.equal(f.current.result_json,null);
  const duplicate=await f.ingress.handle(f.makeRequest(raw));assert.equal(duplicate.status,503);assert.deepEqual(await duplicate.json(),{status:'awaiting-reconciliation',automaticRetry:false});
  gate.resolve();const response=await first;assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');const text=await response.text(),frames=frameData(text);
  assert.equal(frames.at(-1),'[DONE]');assert.deepEqual(frames.at(-2).usage,{prompt_tokens:42,completion_tokens:12,total_tokens:54});
  assert.equal(frames[0].choices[0].delta.role,'assistant');assert.equal(frames.find(frame=>frame.choices?.[0]?.delta.tool_calls)?.choices[0].delta.tool_calls[0].function.name,'lookup_weather');
  assert.equal(frames.at(-3).choices[0].finish_reason,'tool_calls');assert.equal(f.events.filter(event=>event==='supplier').length,1);
  const replay=await f.ingress.handle(f.makeRequest(raw));assert.equal(await replay.text(),text);assert.equal(f.events.filter(event=>event==='supplier').length,1);assert.equal(f.events.filter(event=>event==='finish-committed').length,1);
  for(const changed of [{...raw,stream:false,stream_options:undefined},{...raw,stream_options:{include_usage:false}},{...raw,tools:[{...tool(),function:{...tool().function,description:'changed'}}]}]){
    const conflict=await f.ingress.handle(f.makeRequest(changed));assert.equal(conflict.status,409);}
  assert.equal(f.events.filter(event=>event==='supplier').length,1);
});

test('ambiguous provider results emit no SSE, tool arguments or usage and remain held on repeat',async()=>{
  const bad=provider();bad.usage.total_tokens=0;const f=integrated({providerValue:bad}),raw={...input(),stream:true};
  for(let i=0;i<2;i++){const response=await f.ingress.handle(f.makeRequest(raw));assert.equal(response.status,503);const body=await response.text();assert.doesNotMatch(body,/Winnipeg|tool_calls|prompt_tokens|data:/);}
  assert.equal(f.events.filter(event=>event==='supplier').length,1);assert.equal(f.current.state,'uncertain');assert.equal(f.current.result_json,null);assert.ok(!f.events.includes('finish-start'));
});

test('disconnect after provider work cannot undo settlement or trigger another dispatch',async()=>{
  const gate=deferred(),f=integrated({finishGate:gate}),controller=new AbortController(),raw={...input(),stream:true};
  const pending=f.ingress.handle(f.makeRequest(raw,controller.signal));await f.dispatched.promise;controller.abort();gate.resolve();const response=await pending;
  assert.equal(await response.text(),'');assert.equal(f.current.state,'succeeded');assert.equal(f.events.filter(event=>event==='supplier').length,1);
  const recovered=await f.ingress.handle(f.makeRequest(raw));assert.match(await recovered.text(),/\[DONE\]/);assert.equal(f.events.filter(event=>event==='supplier').length,1);
});

test('settled text SSE preserves Unicode, optional usage and consumer cancellation',async()=>{
  const content='😀'.repeat(5000),completion=settledChatCompletion({ok:true,id:'fixture',result:{model:'fixture-model',created:1791200000,text:content,finishReason:'stop',usage:{prompt_tokens:1,completion_tokens:2}}});
  const frames=frameData(await new Response(bufferedChatStream(completion)).text());assert.equal(frames.filter(frame=>frame.choices?.[0]?.delta.content).map(frame=>frame.choices[0].delta.content).join(''),content);
  assert.ok(frames.slice(0,-1).every(frame=>!Object.hasOwn(frame,'usage')));assert.equal(frames.at(-1),'[DONE]');
  const reader=bufferedChatStream(completion).getReader();await reader.read();await reader.cancel();assert.equal((await reader.read()).done,true);
});

test('HTTP adapter emits SDK SSE wire format after settlement through the owned mount',async()=>{
  const f=integrated(),adapter=createGatewayHttp({ingress:f.ingress}),server=createServer((request,response)=>adapter.handle(request,response));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const reply=await new Promise((resolve,reject)=>{const body=JSON.stringify({...input(),stream:true,stream_options:{include_usage:true}});const request=httpRequest({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{host:'apiwild.com',authorization:'Bearer '+token,'content-type':'application/json','content-length':Buffer.byteLength(body),'idempotency-key':'compatibility_fixture_1'}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}));response.on('error',reject);});request.on('error',reject);request.end(body);});
    assert.equal(reply.status,200);assert.match(reply.headers['content-type'],/^text\/event-stream/);assert.equal(reply.headers['cache-control'],'private, no-store');assert.equal(frameData(reply.text).at(-1),'[DONE]');assert.equal(f.events.filter(event=>event==='supplier').length,1);assert.ok(f.events.includes('finish-committed'));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

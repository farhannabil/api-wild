export type Capability = 'chat'|'code'|'research'|'voice'|'transcribe'|'speak';
export type Provider = 'together'|'you'|'deepgram';
export const rateVersion = '2026-09-08.1';
// USD per million tokens. Routes are explicit; a named model is never substituted.
export const gatewayModels = [
  {id:'apiwild/chat',name:'Chat',model:'Qwen/Qwen3.5-9B',engine:'Qwen 3.5 9B',provider:'together',input:0.17,output:0.25,capabilities:['chat','voice']},
  {id:'apiwild/code',name:'Code',model:'deepseek-ai/DeepSeek-V4-Flash-0731',engine:'DeepSeek V4 Flash',provider:'together',input:0.14,output:0.28,capabilities:['code']},
  {id:'apiwild/research',name:'Research',model:'deepseek-ai/DeepSeek-V4-Flash-0731',engine:'DeepSeek V4 Flash + You Search',provider:'together',input:0.14,output:0.28,capabilities:['research']},
] as const;
export const serviceRates = {searchMicros:5000,transcriptionMicrosPerMinute:4300,speechMicrosPerThousandCharacters:30000};
export const creditPacks = [{id:'starter',name:'Starter',cents:2500,description:'Start with chat, code and research.'},{id:'builder',name:'Builder',cents:10000,description:'One balance for your projects and voice work.'},{id:'scale',name:'Scale',cents:25000,description:'More prepaid credit for regular usage.'}] as const;
export function routeModel(mode:Capability,requested?:string){
  const route=gatewayModels.find(m=>m.id===(mode==='code'?'apiwild/code':mode==='research'?'apiwild/research':'apiwild/chat'))!;
  if(requested&&requested!==route.id&&requested!==route.model)throw new Error('Choose an available model for this mode.');
  return route;
}
export function formatUsageMoney(micros:number){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(micros/1e6);}

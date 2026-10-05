export type Capability = 'chat'|'code'|'research'|'voice'|'transcribe'|'speak';
export type Provider = 'together'|'you'|'deepgram';
export const rateVersion = '2026-09-26.subrouter-candidate.1';
// USD per million tokens. Routes are explicit; a named model is never substituted.
export const gatewayModels = [
  {id:'apiwild/chat',name:'Chat',model:'gpt-6-astra',engine:'GPT 6 Astra via SubRouter',provider:'subrouter',input:0.50,output:2.50,capabilities:['chat','voice']},
  {id:'apiwild/code',name:'Code',model:'deepseek-v4-flash',engine:'DeepSeek V4 Flash via SubRouter',provider:'subrouter',input:0.20,output:0.80,capabilities:['code']},
  {id:'apiwild/research',name:'Research',model:'deepseek-v4-pro',engine:'DeepSeek V4 Pro via SubRouter + You Search',provider:'subrouter',input:0.30,output:1.00,capabilities:['research']},
] as const;
export const serviceRates = {searchMicros:5000,transcriptionMicrosPerMinute:4300,speechMicrosPerThousandCharacters:30000};
export const creditPacks = [
  {id:'smart',name:'SmarT',cents:3300,description:'Adds $33.00 to the shared API WILD usage wallet.'},
  {id:'nerd',name:'NeRD',cents:10100,description:'Adds $101.00 to the shared API WILD usage wallet.'},
  {id:'newton',name:'Newton',cents:23400,description:'Adds $234.00 to the shared API WILD usage wallet.'},
  {id:'alien',name:'Alien',cents:34500,description:'Adds $345.00 to the shared API WILD usage wallet.'},
] as const;
export type CreditPackId = typeof creditPacks[number]['id'];
export type FundingMode = 'one_time'|'monthly';
export const fundingModes = [
  {id:'one_time',label:'One-time funding'},
  {id:'monthly',label:'Monthly funding',activation:'catalog_pending'},
] as const;
export const creditPackAmounts = Object.fromEntries(creditPacks.map(pack=>[pack.id,pack.cents])) as Record<CreditPackId,number>;
export function routeModel(mode:Capability,requested?:string){
  const route=gatewayModels.find(m=>m.id===(mode==='code'?'apiwild/code':mode==='research'?'apiwild/research':'apiwild/chat'))!;
  if(requested&&requested!==route.id&&requested!==route.model)throw new Error('Choose an available model for this mode.');
  return route;
}
export function formatUsageMoney(micros:number){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:6}).format(micros/1e6);}

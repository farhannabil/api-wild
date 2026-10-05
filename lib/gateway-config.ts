import {env} from 'cloudflare:workers';
import {billingConfig} from '@/lib/billing';
import {gatewayModels,rateVersion,serviceRates} from '@/lib/gateway-catalog';
export function gatewayConfig(){
  const billing=billingConfig();
  const enabled=env.GATEWAY_ENABLED==='true'&&env.GATEWAY_ACCEPTANCE_VERIFIED==='true'&&billing.mode==='live'&&billing.enabled;
  const providers={together:!!env.SUBROUTER_API_KEY&&env.SUBROUTER_COMMERCIAL_USE_VERIFIED==='true',you:!!env.YOU_API_KEY&&env.YOU_COMMERCIAL_USE_VERIFIED==='true',deepgram:!!env.DEEPGRAM_API_KEY&&env.DEEPGRAM_COMMERCIAL_USE_VERIFIED==='true'};
  const caps={together:Number(env.SUBROUTER_DAILY_BUDGET_MICROS||0),you:Number(env.YOU_DAILY_BUDGET_MICROS||0),deepgram:Number(env.DEEPGRAM_DAILY_BUDGET_MICROS||0)};
  for(const key of Object.keys(caps) as (keyof typeof caps)[])if(!Number.isSafeInteger(caps[key])||caps[key]<1||caps[key]>1e9)caps[key]=0;
  const ready={chat:enabled&&providers.together&&caps.together>0,code:enabled&&providers.together&&caps.together>0,research:enabled&&providers.together&&providers.you&&caps.together>0&&caps.you>0,voice:enabled&&providers.together&&providers.deepgram&&caps.together>0&&caps.deepgram>0,transcribe:enabled&&providers.deepgram&&caps.deepgram>0,speak:enabled&&providers.deepgram&&caps.deepgram>0};
  return {enabled,providers,caps,ready,mode:billing.mode};
}
export function publicGatewayConfig(){const c=gatewayConfig();return {enabled:c.enabled,ready:c.ready,currency:'usd',rateVersion,rates:serviceRates,models:gatewayModels.map(m=>({...m,available:c.ready[m.name.toLowerCase() as 'chat'|'code'|'research']})),limits:{inputBytes:16000,maxOutputTokens:2048,maxAudioSeconds:60,maxSpeechCharacters:2000,maxConcurrentRequests:2,requestsPerMinute:20},retentionDays:7};}

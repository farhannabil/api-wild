import {deepSeekCalendarTier,DEEPSEEK_CALENDAR_VERSION} from './deepseek-tier-policy.mjs';
import {exactInteger} from './supabase-gateway-rpc.mjs';
export function nativeTariffCharge({model,prompt,completion,created},rates){
 const r=rates[model];if(!r)throw Error('native_rate_unverified');
 exactInteger(prompt,0,10000000);exactInteger(completion,0,10000000);
 let selected=r;
 if(r.processing==='off_peak'){
  exactInteger(r.validFrom,0,2000000000);exactInteger(r.validUntil,r.validFrom+1,2000000000);
  exactInteger(created,r.validFrom,r.validUntil-1);
  if(model!=='deepseek-v4.1-flash'||r.calendar!==DEEPSEEK_CALENDAR_VERSION)throw Error('native_tier_unverified');
  if(deepSeekCalendarTier(created*1000)==='peak')selected=r.peak;
 }
 exactInteger(selected?.input,0,10000000000);exactInteger(selected?.output,0,10000000000);
 return Number((BigInt(prompt)*BigInt(selected.input)+BigInt(completion)*BigInt(selected.output)+999999n)/1000000n);
}

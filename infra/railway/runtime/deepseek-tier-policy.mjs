// Server-owned retail policy, not a claim about the supplier's billing instant.
// Maker pricing/versions checked 2026-10-05; Chinese holiday dates come from
// State Council notice 2025/7. No network, browser tier choice or auto-renewal.
import {GatewayError,cloneJsonObject,strictObject,exactInteger} from './supabase-gateway-rpc.mjs';
const instances=new WeakSet();
export const isDeepSeekTierPolicy=value=>instances.has(value);
export const DEEPSEEK_SOURCE_REVISION='deepseek-pricing-2026-10-05';
export const DEEPSEEK_CALENDAR_VERSION='cn-state-council-2026-7';
const servedVersions=Object.freeze({'deepseek-v4-flash':'DeepSeek-V4.1-Flash','deepseek-v4-pro':'DeepSeek-V4-Pro-0813'});
const holidayRanges=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
const calendarStart=Date.parse('2025-12-31T16:00:00Z'),calendarEnd=Date.parse('2026-12-31T16:00:00Z');
const fail=()=>{throw new GatewayError('deepseek_tariff_unverified');};
const baseValid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,139}$/.test(value);
function stamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))fail();const n=Date.parse(value);if(!Number.isFinite(n)||new Date(n).toISOString()!==value)fail();return n;}
// Pure calendar classifier for audits/tests. Runtime capture additionally needs
// an explicit accepted price window and verified served-model mapping.
export function deepSeekCalendarTier(epochMs){
  exactInteger(epochMs,calendarStart,calendarEnd-1);
  const beijing=new Date(epochMs+8*3600000),day=beijing.toISOString().slice(5,10),weekday=beijing.getUTCDay();
  if(weekday===0||weekday===6||holidayRanges.some(([start,end])=>day>=start&&day<=end))return 'off_peak';
  const utc=new Date(epochMs),minute=utc.getUTCHours()*60+utc.getUTCMinutes();
  return minute>=60&&minute<240||minute>=360&&minute<600?'peak':'off_peak';
}
export function createDeepSeekTierPolicy({enabled=false,config,clock=Date.now}={}){
  if(enabled!==true)return undefined;
  const c=cloneJsonObject(config,8192);
  strictObject(c,['accepted','billingBasis','baseRateVersion','sourceRevision','calendarVersion','validFrom','validUntil','servedVersions']);
  if(c.accepted!==true||c.billingBasis!=='apiwild_admission_time'||!baseValid(c.baseRateVersion)
      ||c.sourceRevision!==DEEPSEEK_SOURCE_REVISION||c.calendarVersion!==DEEPSEEK_CALENDAR_VERSION||typeof clock!=='function')fail();
  const start=stamp(c.validFrom),end=stamp(c.validUntil);
  // Price snapshot validity is finite and explicit. No future-year calendar guess.
  if(start<Date.parse('2026-10-05T00:00:00Z')||start<calendarStart||end<=start||end>calendarEnd||end-start>7*86400000)fail();
  strictObject(c.servedVersions,Object.keys(servedVersions));
  const models=Object.keys(c.servedVersions);if(!models.length||models.some(model=>c.servedVersions[model]!==servedVersions[model]))fail();
  const now=()=>{const t=clock();exactInteger(t,start,end-1);return t;};
  const selections=new WeakSet();
  const version=(model,tier)=>{if(!models.includes(model)||!['peak','off_peak'].includes(tier))fail();return c.baseRateVersion+':ds26:'+tier;};
  const tierFromVersion=(model,value)=>{
    if(!models.includes(model)||typeof value!=='string')fail();
    for(const tier of ['peak','off_peak'])if(value===version(model,tier))return tier;fail();
  };
  const admission=(model,maxExecutionMs)=>{
    exactInteger(maxExecutionMs,1,120000);if(!models.includes(model))fail();
    const admitted=now(),until=admitted+maxExecutionMs;if(until>=end||until>=calendarEnd)fail();
    return {admitted,until};
  };
  const policy=Object.freeze({baseRateVersion:c.baseRateVersion,sourceRevision:c.sourceRevision,calendarVersion:c.calendarVersion,
    models:Object.freeze(models),versions:model=>Object.freeze(['peak','off_peak'].map(tier=>version(model,tier))),
    // Nonspending current availability only. Never mint a tariff selection or
    // turn an invalid/expired clock into an active discovery route.
    canAdmit(model,maxExecutionMs=120000){try{admission(model,maxExecutionMs);return true;}catch{return false;}},
    select(model,maxExecutionMs=120000){
      const {admitted,until}=admission(model,maxExecutionMs);
      const tier=deepSeekCalendarTier(admitted);let reserveTier=tier;
      for(let cursor=Math.ceil(admitted/60000)*60000;cursor<=until;cursor+=60000){if(deepSeekCalendarTier(cursor)==='peak')reserveTier='peak';}
      if(deepSeekCalendarTier(until)==='peak')reserveTier='peak';
      const value=Object.freeze({model,rateVersion:version(model,tier),tier,reserveTier,admittedAt:new Date(admitted).toISOString(),reserveUntil:new Date(until).toISOString()});
      selections.add(value);return value;
    },
    assertSelection(selection,model){if(!selections.has(selection)||selection.model!==model||selection.rateVersion!==version(model,selection.tier))fail();return selection;},
    tierFromVersion,
    assertDispatch(model,rateVersion){now();tierFromVersion(model,rateVersion);},
  });
  instances.add(policy);return policy;
}

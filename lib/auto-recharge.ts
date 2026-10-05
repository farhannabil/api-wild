import {z} from 'zod';
import {creditPackAmounts} from '@/lib/gateway-catalog';

export const autoRechargeConsentVersion='2026-09-26';
export const autoRechargePackIds=['smart','nerd','newton','alien'] as const;
// Use a plain union because the enabled=true branch has a refinement effect;
// Zod discriminated unions require every branch to expose a raw object shape.
export const autoRechargeRequest=z.union([
  z.object({enabled:z.literal(false)}).strict(),
  z.object({
    enabled:z.literal(true),
    thresholdCents:z.number().int().min(100).max(100000),
    refillPack:z.enum(autoRechargePackIds),
    monthlyCapCents:z.number().int().min(3300).max(345000),
    authorizeSavedPaymentMethod:z.literal(true),
    consentVersion:z.literal(autoRechargeConsentVersion),
  }).strict().superRefine((value,ctx)=>{
    const refill=creditPackAmounts[value.refillPack];
    if(value.monthlyCapCents<refill)ctx.addIssue({code:z.ZodIssueCode.custom,path:['monthlyCapCents'],message:'Monthly cap must cover at least one refill.'});
    if(value.thresholdCents>=refill)ctx.addIssue({code:z.ZodIssueCode.custom,path:['thresholdCents'],message:'Threshold must be below the refill value.'});
  }),
]);

export type AutoRechargeRequest=z.infer<typeof autoRechargeRequest>;

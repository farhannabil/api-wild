import {z} from 'zod';
import {countryCodes} from '@/lib/countries';
import {buildingOptions,complianceOptions} from '@/lib/customer-options';
export const onboardingSchema=z.object({name:z.string().trim().min(1,'Enter your name.').max(100),company:z.string().trim().min(1,'Enter a company or project name.').max(120),budget:z.number().int().min(0).max(1000000),accountType:z.enum(['company','personal']),domain:z.string().trim().max(253),phone:z.string().trim().max(40),country:z.enum(countryCodes),building:z.array(z.enum(buildingOptions)).min(1,'Choose at least one use case.').max(3),compliance:z.array(z.enum(complianceOptions)).max(4),project:z.string().trim().max(500)});

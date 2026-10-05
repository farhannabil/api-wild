import type {SupabaseClient} from '@supabase/supabase-js';
import {onboardingSchema} from '@/lib/onboarding-schema';
import {buildingOptions,complianceOptions} from '@/lib/customer-options';
import type {z} from 'zod';

export type CustomerProfileData=z.infer<typeof onboardingSchema>;
type StoredProfile={full_name?:unknown;company_name?:unknown;role?:unknown;use_case?:unknown;onboarding_data?:unknown};
export const emptyCustomerProfile:CustomerProfileData={name:'',company:'',budget:100,accountType:'company',domain:'',phone:'',country:'' as CustomerProfileData['country'],building:[],compliance:[],project:''};

// Stored JSON can predate validation or be edited through the customer's Data API.
// Recover valid fields individually so one malformed preference cannot break the form.
export function customerProfileData(profile:StoredProfile|null):CustomerProfileData {
  const value=profile?.onboarding_data;
  const extra=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  function field<K extends keyof CustomerProfileData>(key:K,value:unknown):CustomerProfileData[K] {
    const parsed=onboardingSchema.shape[key].safeParse(value);
    return (parsed.success?parsed.data:emptyCustomerProfile[key]) as CustomerProfileData[K];
  }
  const useCases=Array.isArray(extra.building)?extra.building:[profile?.use_case];
  const building=[...new Set(useCases.filter((x):x is typeof buildingOptions[number]=>buildingOptions.includes(x as typeof buildingOptions[number])))].slice(0,3);
  const requirements=Array.isArray(extra.compliance)?extra.compliance:[];
  const compliance=[...new Set(requirements.filter((x):x is typeof complianceOptions[number]=>complianceOptions.includes(x as typeof complianceOptions[number])))];
  return {
    name:field('name',profile?.full_name||extra.name),company:field('company',profile?.company_name||extra.company),
    accountType:field('accountType',profile?.role||extra.accountType),budget:field('budget',extra.budget),
    domain:field('domain',extra.domain),phone:field('phone',extra.phone),country:field('country',extra.country),
    building,compliance,project:field('project',extra.project),
  };
}

export class CustomerAccountChangedError extends Error {
  constructor(){super('Your signed-in account changed. Review the reloaded profile before saving.');}
}

// Keep the row owner captured when the form loaded. A later session must never
// receive another account's cached form values, even when it passes its own RLS.
export async function saveCustomerProfile(client:SupabaseClient,ownerId:string,input:unknown){
  const data=onboardingSchema.parse(input);
  const{data:{user},error:userError}=await client.auth.getUser();
  if(userError)throw userError;
  if(!user||user.id!==ownerId)throw new CustomerAccountChangedError();
  const now=new Date().toISOString();
  const{data:saved,error}=await client.from('customer_profiles').upsert({user_id:ownerId,full_name:data.name,company_name:data.company,role:data.accountType,use_case:data.building[0],onboarding_data:data,onboarding_completed_at:now,updated_at:now},{onConflict:'user_id'}).select('user_id').single();
  if(error)throw error;
  if(!saved)throw Error('Your profile was not saved. Please retry.');
}

export function watchCustomerIdentity(client:SupabaseClient,ownerId:string,onChanged:(nextId:string|null)=>void){
  let active=true;
  const{data:{subscription}}=client.auth.onAuthStateChange((_event,session)=>{
    const nextId=session?.user.id??null;
    if(active&&nextId!==ownerId){active=false;onChanged(nextId);}
  });
  return()=>{active=false;subscription.unsubscribe();};
}

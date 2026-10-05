import {notFound} from 'next/navigation';
import Console from '../supabase-console';
const sections=['overview','chat','code','research','usage','api-keys','billing','profile','organization','members','roles','guardrails','provider-keys'];
export default async function Page({params}:{params:Promise<{section:string}>}){const {section}=await params;if(!sections.includes(section))notFound();return <Console section={section}/>}

import {notFound} from 'next/navigation';
import NativeConsole from '../native-console';
export default async function Page({params}:{params:Promise<{section:string}>}){const{section}=await params;if(!['overview','api-keys','usage','billing','profile'].includes(section))notFound();return <NativeConsole section={section}/>}

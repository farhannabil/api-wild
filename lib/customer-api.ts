import {supabaseBrowser} from '@/lib/supabase-browser';
export async function customerApi(path:string,options:RequestInit={}){
 if(!path.startsWith('/api/')||path.startsWith('//')||/[\r\n]/.test(path))throw Error('The account request destination is invalid.');
 const client=await supabaseBrowser(),{data:{session},error}=await client.auth.getSession();
 if(error||!session)throw Error('Your session expired. Sign in again.');
 const response=await fetch(path,{...options,headers:{...options.headers,Authorization:'Bearer '+session.access_token,...(options.body?{'Content-Type':'application/json'}:{})},cache:'no-store',redirect:'error',signal:options.signal||AbortSignal.timeout(180000)});
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error('The account service is temporarily unavailable. Please retry.');
 const data=await response.json();if(!response.ok)throw Object.assign(Error(response.status===401?'Your session expired. Sign in again.':typeof data.error==='string'?data.error:'The request could not be completed.'),{data,status:response.status});return data;
}

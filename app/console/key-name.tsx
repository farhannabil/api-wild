'use client';
import {useState} from 'react';
import {customerApi} from '@/lib/customer-api';
export default function KeyName({id,name,onSaved}:{id:string;name:string;onSaved:(name:string)=>void}){
 const[editing,setEditing]=useState(false),[value,setValue]=useState(name),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(e:React.FormEvent){e.preventDefault();if(busy)return;setBusy(true);setError('');try{const result=await customerApi('/api/billing/key-names',{method:'POST',body:JSON.stringify({id,name:value.trim()})});const saved=result.names?.find((row:{id:string;name:string})=>row.id===id);if(saved?.name!==value.trim())throw Error('Name could not be confirmed.');onSaved(saved.name);setEditing(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <div className="key-name">{editing?<form onSubmit={save}><label>Key name<input autoFocus maxLength={64} value={value} onChange={e=>setValue(e.target.value)} placeholder="Production · my app" disabled={busy}/></label><button disabled={busy||!value.trim()}>{busy?'Saving…':'Save name'}</button><button type="button" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button></form>:<div><strong>{name||'Unnamed key'}</strong><button type="button" onClick={()=>{setValue(name);setEditing(true);}}>{name?'Rename':'Add a name'}</button></div>}{error&&<p role="alert">{error}</p>}</div>;
}

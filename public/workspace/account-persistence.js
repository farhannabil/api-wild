'use strict';
let savedBrief={content:'',id:''};
let accountReady=false;
const stackSave=document.querySelector('#save-account-stack');
const accountNotice=document.querySelector('#account-load-status');
const accountRetry=document.querySelector('#retry-account-load');
async function callAccount(path,method,payload){const response=await fetch(path,{method,headers:payload?{'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined});const data=await response.json();if(!response.ok)throw Error(data.error||'Unable to save. Please retry.');return data;}
document.querySelector('#save-account-stack').addEventListener('click',async e=>{if(!accountReady)return;const button=e.currentTarget;button.disabled=true;try{await callAccount('/api/account','PUT',{stack:[...state.stack]});toast('Stack saved to your account.');}catch(error){toast(error.message);}finally{button.disabled=false;}});
document.querySelector('#save-account-brief').addEventListener('click',async e=>{const form=document.querySelector('#brief-form');if(!form.reportValidity())return;const button=e.currentTarget;const f=new FormData(form);const content=`# ${f.get('business')} — solution brief\n\n## Goal\n${f.get('goal')}\n\n- Type: ${f.get('type')}\n- Volume: ${f.get('volume')}\n- Tools: ${f.getAll('tools').join(', ')||'To define'}\n- Autonomy: ${f.get('autonomy')}\n- Monthly budget: USD ${f.get('budget')}\n\nPlanning brief only. No order or service activation.\n`;if(savedBrief.content!==content)savedBrief={content,id:crypto.randomUUID()};button.disabled=true;try{await callAccount('/api/briefs','POST',{id:savedBrief.id,title:String(f.get('business')).slice(0,120),content});toast('Brief saved. Find it in My account.');}catch(error){toast(error.message);}finally{button.disabled=false;}});
async function hydrateAccount(){
 accountReady=false;stackSave.disabled=true;accountRetry.hidden=true;accountNotice.textContent='Loading your saved stack…';
 try{
  const data=await callAccount('/api/account','GET');
  if(!data.profile){accountNotice.textContent='Complete your account profile before saving.';return;}
  const ids=JSON.parse(data.profile.stack);
  if(!Array.isArray(ids))throw Error('Unable to load your saved stack.');
  ids.forEach(id=>{if(catalog.some(p=>p.id===id))state.stack.add(id)});
  renderStack();accountReady=true;stackSave.disabled=false;accountNotice.textContent='Your saved stack is loaded.';
 }catch(error){accountNotice.textContent=error.message;accountRetry.hidden=false;}
}
accountRetry.addEventListener('click',hydrateAccount);
hydrateAccount();

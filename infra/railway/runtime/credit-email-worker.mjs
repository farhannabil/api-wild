import {resendReceipt} from '../resend-outbox.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function creditMessage(job){
 if(!uuid.test(job?.id??'')||!uuid.test(job?.leaseId??'')||!Number.isSafeInteger(job.amountCents)||job.amountCents<=0||job.amountCents>100000000||!['card','promo'].includes(job.source)||typeof job.recipient!=='string'||job.recipient.length>254||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(job.recipient)||/[\x00-\x1f\x7f]/.test(job.recipient))throw Error('credit_email_invalid');
 const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(job.amountCents/100);
 const message=`${amount} USD in API WILD credits has been added to your account${job.source==='promo'?' from your promo code':''}.`;
 return {from:'API WILD <support@apiwild.com>',to:[job.recipient],subject:`${amount} in credits added to API WILD`,text:`${message}\nView your credits and activity: https://apiwild.com/console/billing\nQuestions? Contact support@apiwild.com.`,html:`<div style="background:#111827;padding:32px;color:#fff;font-family:Arial,sans-serif"><p style="color:#a5b4fc;letter-spacing:3px">API WILD</p><h1>Your next idea is funded.</h1><p style="font-size:32px">${amount} USD</p><p>${message}</p><p><a style="color:#a5b4fc" href="https://apiwild.com/console/billing">View your credits →</a></p><p>Questions? Contact support@apiwild.com.</p></div>`,tags:[{name:'email_type',value:'credits_added'}]};
}
export function createCreditEmailWorker({rpc,apiKey,fetchImpl=fetch,enabled=false,write=()=>{}}){
 let timer,active=false,stopped=false;
 async function tick(){
  if(!enabled||!apiKey||active||stopped)return;active=true;
  try{
   const job=await rpc('apiwild_claim_credit_email',{});if(!job)return;
   let outcome='retry',provider=null;
   try{const message=creditMessage(job);const result=await resendReceipt(fetchImpl,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':'credit-email/'+job.id},body:JSON.stringify(message)});
    if(result.ok&&uuid.test(result.id??'')){outcome='sent';provider=result.id;}
    else if(!result.ok&&result.status!==429&&result.status<500)outcome='failed';
   }catch{/* Retry the exact event within the database-enforced idempotency window. */}
   const result=await rpc('apiwild_finish_credit_email',{p_id:job.id,p_lease:job.leaseId,p_outcome:outcome,p_provider:provider});
   write({creditEmail:result.finished?outcome:'lease-unconfirmed'});
  }catch{write({creditEmail:'unavailable'});}finally{active=false;}
 }
 return Object.freeze({tick,start(){if(timer||!enabled||!apiKey)return;stopped=false;timer=setInterval(()=>void tick(),60000);timer.unref?.();void tick();},stop(){stopped=true;clearInterval(timer);timer=null;}});
}

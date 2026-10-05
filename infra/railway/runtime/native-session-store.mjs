// Private process memory only: one replica; all sessions revoke on restart.
export function createNativeSessionStore({maxSessions=1000,now=Date.now}={}) {
 if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>10000||typeof now!=='function')throw Error('Invalid native session store.');
 const records=new Map();
 const prune=()=>{for(const [key,value] of records)if(value.expiresAt<=now())records.delete(key);};
 return Object.freeze({
  async get(key){prune();const value=records.get(key);return value?{...value}:undefined;},
  async delete(key){records.delete(key);},
  async put(key,value){prune();if(!/^[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(value?.userId)||value.userId<1||typeof value.sessionCookie!=='string'||!value.sessionCookie.length||value.sessionCookie.length>8192||/[\x00-\x1f\x7f]/.test(value.sessionCookie)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now()||value.expiresAt>now()+3600000)throw Error('Invalid native session record.');
   if(!records.has(key)&&records.size>=maxSessions)throw Error('Native session capacity reached.');
   records.set(key,{userId:value.userId,sessionCookie:value.sessionCookie,expiresAt:value.expiresAt});
  },
 });
}

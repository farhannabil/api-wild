import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
// Public CI imports omit the private Sites identity. This stub is for builds only.
if(!existsSync('.openai/hosting.json')) {
  mkdirSync('.openai',{recursive:true});
  writeFileSync('.openai/hosting.json',JSON.stringify({d1:'DB',r2:null}));
}

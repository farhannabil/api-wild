import{spawn}from'node:child_process';
import fs from 'node:fs/promises';
import {LINUX} from './platform.mjs';
const unavailable=()=>Object.assign(Error('GITHUB_CREDENTIAL_UNAVAILABLE'),{code:'GITHUB_CREDENTIAL_UNAVAILABLE'});
export function credentialEnvironment(token){
 if(typeof token!=='string'||!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token))throw unavailable();
 return{github:{GH_TOKEN:token},git:{GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+token).toString('base64')}};
}
async function protectedToken(){
 if(LINUX){const file='/srv/apiwild-maintenance/secrets/github-token';const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid()||stat.size>4096)throw unavailable();return fs.readFile(file,'utf8');}
 return new Promise((resolve,reject)=>{const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File','C:/Users/farha/.claude/it-team/apiwild-autonomy/load-github-credential.ps1'],{windowsHide:true,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows',USERPROFILE:'C:/Users/farha',APPDATA:'C:/Users/farha/AppData/Roaming',LOCALAPPDATA:'C:/Users/farha/AppData/Local',PATH:'C:/Windows/System32'},stdio:['ignore','pipe','pipe']});let value='',bounded=true;
 child.stdout.on('data',b=>{if(value.length+b.length>4096){bounded=false;child.kill();}else value+=b;});child.stderr.on('data',()=>{});const timeout=setTimeout(()=>child.kill(),8000);
 child.once('error',()=>{clearTimeout(timeout);reject(unavailable());});child.once('close',code=>{clearTimeout(timeout);if(code!==0||!bounded)reject(unavailable());else resolve(value.trim());});
 });
}
// Decrypt once per short-lived tick. No plaintext file, CLI argument or log.
export function createCredentialLoader(reader=protectedToken){let cached;return()=>cached??=(Promise.resolve().then(reader).then(credentialEnvironment).catch(()=>{throw unavailable();}));}

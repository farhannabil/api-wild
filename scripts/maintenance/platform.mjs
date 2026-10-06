import path from 'node:path';
export const LINUX=process.platform==='linux';
if(!LINUX&&process.platform!=='win32')throw Error('UNSUPPORTED_MAINTENANCE_HOST');
export const HOME=LINUX?'/srv/apiwild-maintenance/operator':'C:/Users/farha/.claude/it-team/apiwild-autonomy';
export const USER_HOME=LINUX?'/srv/apiwild-maintenance/user':'C:/Users/farha';
export const INCIDENTS=LINUX?'/srv/apiwild-maintenance/incidents':'C:/Users/farha/OneDrive/Documents/ChatGPT/Websites/work/apiwild-autonomous-incidents';
export const REPO_PREFIX=LINUX?'/srv/apiwild-maintenance/':'c:/users/farha/onedrive/documents/chatgpt/websites/work/';
export const GIT=LINUX?'/usr/bin/git':'C:/Users/farha/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe';
export const GH=LINUX?'/usr/local/bin/gh':'C:/Users/farha/AppData/Local/Programs/GitHub CLI/bin/gh.exe';
export const NODE=LINUX?'/usr/local/bin/node':'C:/Program Files/nodejs/node.exe';
export const GUARD=LINUX?'/srv/apiwild-maintenance/guard/guardian.mjs':'C:/Users/farha/.claude/setup-runtime/paperclip-cli-once.exe';
export const MANIFEST=LINUX?HOME+'/jobs.tsv':'C:/Users/farha/.claude/it-team/paperclip-cli-once-jobs.tsv';
export const VERIFY=LINUX?'node '+HOME+'/agent-entry.mjs verify-current':'node C:/Users/farha/.claude/scripts/apiwild-maintenance-controller.mjs verify-current';
export function normal(value){const resolved=path.resolve(value).replaceAll('\\','/');return LINUX?resolved:resolved.toLowerCase();}
export function childEnvironment(extra={}){
 const fixed=LINUX?{HOME:USER_HOME,USER:'apiwild-maintenance',LOGNAME:'apiwild-maintenance',TMPDIR:'/tmp',PATH:'/usr/local/bin:/usr/bin:/bin'}:{SystemRoot:process.env.SystemRoot??'C:/Windows',WINDIR:process.env.WINDIR??'C:/Windows',TEMP:process.env.TEMP,TMP:process.env.TMP,USERPROFILE:USER_HOME,APPDATA:USER_HOME+'/AppData/Roaming',LOCALAPPDATA:USER_HOME+'/AppData/Local',PATH:path.dirname(GIT)+';C:/Program Files/nodejs;C:/Windows/System32'};
 return{...fixed,...extra};
}

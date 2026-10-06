// Invoked only by the existing approved Claude apiKeyHelper authentication flow.
import fs from'node:fs/promises';
const file='/srv/apiwild-maintenance/secrets/provider-key';
try{const stat=await fs.lstat(file);if(process.platform!=='linux'||!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid()||stat.size<16||stat.size>4096)throw Error();const value=(await fs.readFile(file,'utf8')).trim();if(!value||/[\r\n]/.test(value))throw Error();process.stdout.write(value);}catch{process.stderr.write('EXISTING_PROVIDER_CREDENTIAL_UNAVAILABLE\n');process.exitCode=1;}

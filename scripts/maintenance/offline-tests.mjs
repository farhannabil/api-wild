// Operator-owned preload. Real product tests use injected fixtures or loopback
// HTTP; supplier/payment/email network calls and child commands are forbidden.
import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import http2 from 'node:http2';import dgram from 'node:dgram';
import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Object.assign(Error('Offline verification forbids external effects'),{code:'OFFLINE_EXTERNAL_EFFECT_DENIED'});};
const local=host=>['127.0.0.1','localhost','::1','[::1]'].includes(host);
const fixturePorts=new Set(),listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){const input=args[0];if(input===0||input?.port===0)this.once('listening',()=>{const address=this.address();if(address&&typeof address==='object')fixturePorts.add(address.port);});return listen.apply(this,args);};
function target(args){if(Array.isArray(args[0]))return target(args[0]);const first=args[0];if(typeof first==='string'&&/^https?:/.test(first))return new URL(first).hostname;if(first instanceof URL)return first.hostname;if(first&&typeof first==='object')return first.hostname??first.host??'localhost';return typeof args[1]==='string'?args[1]:'localhost';}
function port(args){if(Array.isArray(args[0]))return port(args[0]);const first=args[0];if(first instanceof URL||typeof first==='string'&&/^https?:/.test(first))return Number(new URL(first).port||80);return Number(first&&typeof first==='object'?first.port:first);}
function wrap(owner,key){const original=owner[key];owner[key]=function(...args){if(!local(target(args))||!fixturePorts.has(port(args)))denied();return original.apply(this,args);};}
for(const [owner,key]of [[net,'connect'],[net,'createConnection'],[tls,'connect'],[http,'request'],[http,'get'],[https,'request'],[https,'get']])wrap(owner,key);
wrap(net.Socket.prototype,'connect');http2.connect=denied;dgram.Socket.prototype.send=denied;
globalThis.fetch=denied;
// The trusted Node test parent launches fixed workers. Within each worker,
// repository code cannot use exported subprocess APIs. This is a same-user
// guard, not an OS sandbox against deliberately hostile code.
if(process.env.NODE_TEST_CONTEXT)for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[key]=denied;
syncBuiltinESMExports();

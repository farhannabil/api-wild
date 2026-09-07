import { env } from 'cloudflare:workers';
export function database(){if(!env.DB)throw new Error('Database unavailable');return env.DB;}
export function respond(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});}
export function identity(request:Request){const id=request.headers.get('oai-authenticated-user-id');const email=request.headers.get('oai-authenticated-user-email');return id&&email?{id,email}:null;}
export function trustedWrite(request:Request){const origin=request.headers.get('origin');return origin===new URL(request.url).origin&&request.headers.get('content-type')?.includes('application/json');}
export class RequestError extends Error { constructor(message:string,public status:number){super(message);} }
export async function readTextBounded(request:Request,limit:number){const reader=request.body?.getReader();if(!reader)throw new RequestError('A JSON body is required.',400);const decoder=new TextDecoder();let text='',bytes=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>limit){await reader.cancel();throw new RequestError('Request too large.',413);}text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}}

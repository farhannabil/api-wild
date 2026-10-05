import {readTextBounded,RequestError} from '@/db/service';
import {createStorefrontCheckout,storefrontOrigin} from '@/lib/storefront';
function headers(origin:string){return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin','Cache-Control':'no-store'};}
export function OPTIONS(r:Request){const origin=r.headers.get('origin')||'';return new Response(null,{status:storefrontOrigin(origin)?204:403,headers:storefrontOrigin(origin)?headers(origin):{}});}
export async function POST(r:Request){
 const origin=r.headers.get('origin')||'';
 if(!storefrontOrigin(origin)||!r.headers.get('content-type')?.includes('application/json'))return Response.json({error:'Invalid origin.'},{status:403});
 try{const input=JSON.parse(await readTextBounded(r,4096));const result=await createStorefrontCheckout(input,origin,r.headers.get('cf-connecting-ip')||'unknown');return Response.json(result,{headers:headers(origin)});}
 catch(e){const status=e instanceof RequestError?e.status:e instanceof SyntaxError?400:503;return Response.json({error:e instanceof RequestError?e.message:'Le paiement est momentanément indisponible. Veuillez réessayer.'},{status,headers:headers(origin)});}
}

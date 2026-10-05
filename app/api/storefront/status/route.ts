import {database} from '@/db/service';
import {storefrontCatalog,storefrontOrigin} from '@/lib/storefront';
export async function GET(r:Request){
 const origin=r.headers.get('origin')||'';
 if(!storefrontOrigin(origin))return Response.json({error:'Invalid origin.'},{status:403});
 const headers={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store'};
 const id=new URL(r.url).searchParams.get('order_id')||'';
 if(!/^store_[a-f0-9-]{36}$/.test(id))return Response.json({error:'Invalid order.'},{status:400,headers});
 try{const row=await database().prepare('SELECT status,brand FROM storefront_orders WHERE id=?').bind(id).first<{status:string;brand:string}>();
 if(!row||storefrontCatalog.brands[row.brand]?.origin!==origin)return Response.json({error:'Order not found.'},{status:404,headers});
 return Response.json({status:row.status,activation:row.status==='paid'?'manual_pending':'not_ready'},{headers});
 }catch{return Response.json({error:'Status temporarily unavailable.'},{status:503,headers});}
}

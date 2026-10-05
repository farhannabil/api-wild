import {getSubRouterCatalogue} from '@/lib/subrouter-catalogue-server';
export async function GET(){return Response.json(await getSubRouterCatalogue(),{headers:{'Cache-Control':'public, max-age=300'}});}

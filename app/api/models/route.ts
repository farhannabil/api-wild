import {catalog} from '@/lib/catalog';
export async function GET(){return Response.json(catalog,{headers:{'Cache-Control':'public, max-age=300'}});}

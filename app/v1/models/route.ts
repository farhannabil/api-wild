import {keyIdentity} from '@/lib/key-auth';
import {catalog} from '@/lib/catalog';
import {respond} from '@/db/service';
export async function GET(r:Request){try{if(!await keyIdentity(r))return respond({error:'Invalid, expired or revoked API key.'},401);return respond({object:'list',data:catalog.models.map(m=>({id:m.id,object:'model',owned_by:m.provider})),source:catalog.source,fetched_at:catalog.fetchedAt,inference_available:false});}catch{return respond({error:'Service unavailable.'},503);}}

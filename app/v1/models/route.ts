import {gatewayIdentity} from '@/lib/gateway-auth';
import {publicGatewayConfig} from '@/lib/gateway-config';
import {RequestError} from '@/db/service';
import {keyIdentity} from '@/lib/key-auth';
import {catalog} from '@/lib/catalog';
import {respond} from '@/db/service';
export async function GET(r:Request){try{if(r.headers.get('authorization')?.startsWith('Bearer aw_')){await gatewayIdentity(r);const c=publicGatewayConfig();return respond({object:'list',data:c.models.map(m=>({id:m.id,object:'model',owned_by:'apiwild',provider_model:m.model,available:m.available,pricing:{input_per_million:m.input,output_per_million:m.output,currency:'usd'}})),rate_version:c.rateVersion});}if(!await keyIdentity(r))return respond({error:'Invalid, expired or revoked API key.'},401);return respond({object:'list',data:catalog.models.map(m=>({id:m.id,object:'model',owned_by:m.provider})),source:catalog.source,fetched_at:catalog.fetchedAt,inference_available:false});}catch(e){return respond({error:e instanceof RequestError?e.message:'Service unavailable.'},e instanceof RequestError?e.status:503);}}

import {respond} from '@/db/service';
import {publicGatewayConfig} from '@/lib/gateway-config';
export async function GET(){return respond(publicGatewayConfig());}

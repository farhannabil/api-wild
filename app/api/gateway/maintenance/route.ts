import {gatewayOperator} from '@/lib/gateway-operations';
import {maintainGateway} from '@/lib/gateway-ledger';
import {maintainAaroUsage} from '@/lib/aaro-usage';
import {respond,RequestError} from '@/db/service';
export async function POST(r:Request){try{await gatewayOperator(r);await maintainAaroUsage();return respond({states:await maintainGateway()});}catch(e){return respond({error:e instanceof RequestError?e.message:'Maintenance failed.'},e instanceof RequestError?e.status:503);}}

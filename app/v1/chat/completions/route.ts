import {gatewayPost} from '@/lib/gateway';
export async function POST(r:Request){return gatewayPost(r,true);}

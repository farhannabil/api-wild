import {getSubRouterCatalogue} from '@/lib/subrouter-catalogue-server';
import Models from './models-client';
export default async function Page(){return <Models snapshot={await getSubRouterCatalogue()}/>}

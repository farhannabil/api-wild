import {notFound} from 'next/navigation';
import catalog from '../public-models.json';
import ModelDetail from './model-detail';

export default async function Page({params}:{params:Promise<{modelId:string}>}){
 const {modelId}=await params;
 const model=catalog.models.find(item=>item.model_name===modelId);
 if(!model)notFound();
 return <ModelDetail model={model}/>;
}

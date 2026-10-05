import {ArrowUpRight} from 'lucide-react';
import SelectedSuppliers from './selected-suppliers';

export default function Models(){
 return <main id="main" className="model-page"><div className="console-title"><div><span className="section-overline">API WILD MODEL DIRECTORY</span><h1>Leading models. One API.</h1><p>Compare our selected models and approved input and output token prices.</p></div><a className="pill-button dark" href="/pricing">Compare pricing <ArrowUpRight size={15}/></a></div><SelectedSuppliers/></main>;
}

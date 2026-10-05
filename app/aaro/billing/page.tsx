import type {Metadata} from 'next';
import AaroBilling from './view';
export const metadata:Metadata={title:'AARO — Monthly billing'};
export default function Page(){return <main id="main" className="content-wrap" style={{maxWidth:1100,margin:'4rem auto',padding:'0 1.25rem'}}><AaroBilling/></main>}

import type {Metadata} from 'next';
import './globals.css';
import './console.css';
import './api-wild.css';
import {Header,Footer} from './chrome';
import {AuthLinkGuard} from './auth-link-guard';
export const metadata:Metadata={title:'API WILD — Models, agents, automation',description:'Discover AI model APIs, tailored agents and business automation. Build your stack with API WILD.',icons:{icon:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body><AuthLinkGuard/><a className="skip-link" href="#main">Skip to content</a><Header/>{children}<Footer/></body></html>}

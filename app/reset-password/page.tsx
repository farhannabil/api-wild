import {ApiWildMark} from '@/app/api-wild-brand';
import {AuthForm} from '@/app/auth-form';
export const metadata={title:'Choose a new password. | API WILD'};
export default function Page(){return <main id="main" className="auth-entry"><div className="auth-card"><ApiWildMark className="auth-brand-mark"/><span className="section-overline">API WILD ACCOUNT</span><h1>Choose a new password.</h1><p>Secure your API WILD account with a new password.</p><AuthForm mode="reset"/><p><a href="/login">Back to sign in</a></p></div><div className="auth-aside"><span>YOUR API WILD WORKSPACE</span><h2>Back to<br/>what’s next.</h2></div></main>}

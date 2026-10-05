import {ApiWildMark} from '@/app/api-wild-brand';
import NativeAuthForm from '../native-auth-form';
import '../native-console.css';
export default function Page(){return <main id="main" className="auth-entry"><div className="auth-card"><ApiWildMark className="auth-brand-mark"/><span className="section-overline">API WILD API ACCOUNT</span><h1>One account.<br/>Your model access.</h1><p>Sign in to manage API keys, credit balance and usage.</p><NativeAuthForm mode="login"/><p>New here? <a href="/api-account/signup">Create an API account</a></p><p className="auth-fine">Existing saved business profile? <a href="/login">Sign in to your profile workspace</a>. Profile and API accounts are separate until account linking is available.</p></div></main>}

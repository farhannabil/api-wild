import {ApiWildMark} from '@/app/api-wild-brand';
import NativeAuthForm from '../native-auth-form';
import '../native-console.css';
export default function Page(){return <main id="main" className="auth-entry"><div className="auth-card"><ApiWildMark className="auth-brand-mark"/><span className="section-overline">JOIN API WILD</span><h1>Create your<br/>API account.</h1><p>Choose a username for model access, API keys and credit management. No payment is taken during registration.</p><NativeAuthForm mode="signup"/><p>Already have an API account? <a href="/api-account/login">Sign in</a></p><p className="auth-fine">This account manages model API access. It does not automatically link to an existing business profile.</p></div></main>}

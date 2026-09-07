import {ApiWildBrand} from '@/app/api-wild-brand';
import {AuthForm} from '@/app/auth-form';
export default function VerifyEmail(){return <main id="main" className="auth-entry"><div className="auth-card"><ApiWildBrand/><span className="section-overline">VERIFY YOUR EMAIL</span><h1>A fresh start.</h1><p>Enter your account email and we’ll send a new confirmation link. Use the most recent email.</p><AuthForm mode="verify"/><p>Already confirmed? <a href="/login">Sign in</a></p></div></main>}

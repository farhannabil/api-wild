import {cn} from '@/lib/utils';

export function ApiWildMark({className,...props}:React.ComponentProps<'svg'>){
 return <svg className={cn('api-wild-mark',className)} viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}><circle cx="24" cy="24" r="20.5" stroke="currentColor" strokeWidth="1.2" opacity=".2"/><path d="M5.1 16A20.5 20.5 0 0 1 37.5 8.6M42.9 32A20.5 20.5 0 0 1 10.5 39.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><path d="m35.5 5.8 5 5" stroke="#6a5cff" strokeWidth="2.4" strokeLinecap="round"/><text x="24" y="29.5" textAnchor="middle" fill="currentColor" fontFamily="monospace" fontSize="17" fontWeight="600" letterSpacing="-2">0x</text></svg>;
}
export function ApiWildBrand({className}:{className?:string}){return <span className={cn('api-wild-brand',className)} aria-label="API WILD"><ApiWildMark/><span className="api-wild-name"><strong>API</strong><span>WILD</span></span></span>}

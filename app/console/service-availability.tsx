const details:Record<string,{title:string;description:string}>={
 chat:{title:'Chat playground',description:'The browser chat interface is not connected to the current API WILD gateway yet.'},
 code:{title:'Coding playground',description:'The browser coding interface is not connected to the current API WILD gateway yet.'},
 research:{title:'Research playground',description:'Research tools and browser execution are not connected to this account yet.'},
 guardrails:{title:'Guardrails',description:'Account-wide guardrail policies are not implemented in the current gateway. API key spending and capability limits can be configured in API keys.'},
 'provider-keys':{title:'Provider connections',description:'API WILD manages upstream credentials privately. Customer-supplied provider keys are not connected yet.'},
 members:{title:'Workspace members',description:'Member invitations and shared workspace access are not implemented yet.'},
 roles:{title:'Roles and permissions',description:'Workspace role management is not implemented yet. Your account currently manages its own resources.'},
};
export default function ServiceAvailability({section}:{section:string}){const detail=details[section]??{title:'Service setup',description:'This feature is not connected yet.'};return <section className="console-panel"><h2>{detail.title}</h2><span className="subtle-chip">Not connected</span><p>{detail.description}</p><p>There is no action to retry here. This page will offer controls when the service is connected and verified.</p><div className="native-actions"><a className="pill-button outline" href="/console/api-keys">API keys and connection instructions</a><a className="text-link" href="/console/billing">Credits and billing</a><a className="text-link" href="/models">Model catalogue</a></div></section>}

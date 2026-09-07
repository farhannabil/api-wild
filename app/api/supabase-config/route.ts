import {env} from 'cloudflare:workers';

export const dynamic='force-dynamic';

export function GET(){
  const url=env.SUPABASE_URL;
  const publishableKey=env.SUPABASE_PUBLISHABLE_KEY;
  if(!url||!publishableKey)return Response.json({error:'Customer sign-in is not configured.'},{status:503,headers:{'Cache-Control':'no-store'}});
  return Response.json({url,publishableKey},{headers:{'Cache-Control':'no-store'}});
}

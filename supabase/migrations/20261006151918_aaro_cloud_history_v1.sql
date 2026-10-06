-- SOURCE SCHEMA PROPOSAL ONLY: not applied or registered as a Supabase CLI
-- migration. Isolated PG18/auth-shim tests are not real Supabase acceptance.
-- Target: yautmilnpllojugpmfgy only.
-- Owner lane must inventory existing objects, generate the proper migration,
-- run anon/anonymous/two-owner RLS and concurrent CAS tests, run advisors, and
-- verify the exact deployed source before enabling AARO_CLOUD_HISTORY_ENABLED.
-- No existing customer/device data is copied, deleted, or replaced by this file.
-- Sources checked: Supabase RLS/API key/Data API grants documentation and
-- PostgREST v14 RPC/errors documentation on 2026-10-03.
-- This one-row-per-owner snapshot is bounded storage, not an entitlement/credit
-- ledger. Device export/import and explicit conflict review remain separate.

begin;
create schema aaro_private;
revoke all on schema aaro_private from public, anon, authenticated, service_role;

create function public.aaro_workspace_snapshot_valid_v1(p_snapshot jsonb)
returns boolean language plpgsql immutable security invoker set search_path = ''
as $$
declare
  p jsonb; c jsonb; m jsonb;
  project_ids text[] := array[]::text[];
  chat_ids text[] := array[]::text[];
begin
  -- JSONB text includes formatting spaces: 300KB DB bound complements the
  -- server's stricter 256KiB canonical JSON bound. No truncation is performed.
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
    or not (p_snapshot ?& array['version','projects','chats','selectedProject'])
    or (select count(*) from jsonb_object_keys(p_snapshot)) <> 4
    or p_snapshot->'version' <> '1'::jsonb
    or jsonb_typeof(p_snapshot->'projects') <> 'array'
    or jsonb_typeof(p_snapshot->'chats') <> 'array'
    or octet_length(p_snapshot::text) > 300000
  then return false; end if;
  if jsonb_array_length(p_snapshot->'projects') > 100
    or jsonb_array_length(p_snapshot->'chats') > 500
  then return false; end if;

  for p in select value from jsonb_array_elements(p_snapshot->'projects') loop
    if jsonb_typeof(p) <> 'object'
      or not (p ?& array['id','name','notes','updated'])
      or (select count(*) from jsonb_object_keys(p)) <> 4
      or jsonb_typeof(p->'id') <> 'string' or p->>'id' !~ '^[A-Za-z0-9_-]{1,100}$'
      or p->>'id' = any(project_ids)
      or jsonb_typeof(p->'name') <> 'string' or length(p->>'name') > 100 or btrim(p->>'name') = ''
      or jsonb_typeof(p->'notes') <> 'string' or length(p->>'notes') > 12000
      or jsonb_typeof(p->'updated') <> 'string' or length(p->>'updated') > 40
      or (p->>'updated' <> '' and p->>'updated' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')
    then return false; end if;
    project_ids := array_append(project_ids, p->>'id');
  end loop;
  if p_snapshot->'selectedProject' <> 'null'::jsonb and
    (jsonb_typeof(p_snapshot->'selectedProject') <> 'string'
      or not (p_snapshot->>'selectedProject' = any(project_ids)))
  then return false; end if;

  for c in select value from jsonb_array_elements(p_snapshot->'chats') loop
    if jsonb_typeof(c) <> 'object'
      or not (c ?& array['id','title','projectId','updated','messages'])
      or (select count(*) from jsonb_object_keys(c)) <> 5
      or jsonb_typeof(c->'id') <> 'string' or c->>'id' !~ '^[A-Za-z0-9_-]{1,100}$'
      or c->>'id' = any(chat_ids)
      or jsonb_typeof(c->'title') <> 'string' or length(c->>'title') > 200
      or jsonb_typeof(c->'updated') <> 'string' or length(c->>'updated') > 40
      or (c->>'updated' <> '' and c->>'updated' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')
      or (c->'projectId' <> 'null'::jsonb and (jsonb_typeof(c->'projectId') <> 'string' or not (c->>'projectId' = any(project_ids))))
      or jsonb_typeof(c->'messages') <> 'array'
    then return false; end if;
    if jsonb_array_length(c->'messages') > 300 then return false; end if;
    chat_ids := array_append(chat_ids, c->>'id');
    for m in select value from jsonb_array_elements(c->'messages') loop
      if jsonb_typeof(m) <> 'object'
        or not (m ?& array['role','content','serviceError'])
        or (select count(*) from jsonb_object_keys(m)) <> 3
        or jsonb_typeof(m->'role') <> 'string' or m->>'role' not in ('user','assistant','system')
        or jsonb_typeof(m->'content') <> 'string' or length(m->>'content') > 100000
        or jsonb_typeof(m->'serviceError') <> 'boolean'
      then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then
  -- Malformed structure is rejected, never coerced or silently truncated.
  return false;
end;
$$;

create table public.aaro_workspaces (
  owner_id uuid primary key references auth.users(id),
  product text not null default 'aaro' check (product = 'aaro'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  snapshot jsonb not null check (public.aaro_workspace_snapshot_valid_v1(snapshot)),
  updated_at timestamptz not null default now()
);
-- The owner primary key is also the index for both RLS and CAS predicates.
alter table public.aaro_workspaces enable row level security;
alter table public.aaro_workspaces force row level security;
revoke all on table public.aaro_workspaces from public, anon, authenticated, service_role;
grant select on table public.aaro_workspaces to authenticated;
-- Non-exposed fixed-owner lookup is needed because auth.users is service-owned.
-- Neither its rows nor broad auth-schema privileges are granted to customers.
create function aaro_private.customer_is_confirmed_v1()
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt()->'is_anonymous' = 'false'::jsonb, false)
    and exists (select 1 from auth.users u where u.id = auth.uid()
      and u.email_confirmed_at is not null and u.is_anonymous = false);
$$;
create policy aaro_workspaces_select on public.aaro_workspaces for select to authenticated
using ((select auth.uid()) = owner_id and product = 'aaro'
  and (select auth.jwt()->'is_anonymous') = 'false'::jsonb
  and (select aaro_private.customer_is_confirmed_v1()));
-- No direct INSERT/UPDATE/DELETE grants/policies: writes must use the fixed CAS
-- implementation below, not an arbitrary owner table mutation or revision jump.

create function aaro_private.save_workspace_v1(p_expected_revision bigint, p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path = ''
set statement_timeout = '5s'
as $$
declare
  current_owner uuid := auth.uid();
  saved jsonb;
begin
  if current_owner is null or aaro_private.customer_is_confirmed_v1() is not true
  then raise sqlstate '42501' using message = 'Confirmed customer session required.'; end if;
  -- Both Auth's current stored confirmation and the verified JWT owner are used;
  -- this is not persisted session_id revocation after signout.
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or not public.aaro_workspace_snapshot_valid_v1(p_snapshot)
  then raise sqlstate '22023' using message = 'Invalid cloud snapshot.'; end if;
  if p_expected_revision = 0 then
    insert into public.aaro_workspaces (owner_id, product, revision, snapshot)
    values (current_owner, 'aaro', 1, p_snapshot)
    on conflict (owner_id) do nothing
    returning jsonb_build_object('owner_id',owner_id,'product',product,'revision',revision,'snapshot',snapshot) into saved;
  else
    update public.aaro_workspaces set snapshot = p_snapshot, revision = revision + 1, updated_at = now()
    where owner_id = current_owner and product = 'aaro' and revision = p_expected_revision
    returning jsonb_build_object('owner_id',owner_id,'product',product,'revision',revision,'snapshot',snapshot) into saved;
  end if;
  -- Conflicting first saves/updates never reread and overwrite. PostgreSQL's
  -- single-statement row locking decides exactly one matching revision winner.
  if saved is null then raise sqlstate 'PT409' using message = 'Workspace revision conflict.'; end if;
  return saved;
end;
$$;
-- Exposed wrapper is unprivileged and forwards only the two fixed CAS fields.
create function public.aaro_save_workspace_v1(p_expected_revision bigint, p_snapshot jsonb)
returns jsonb language sql security invoker set search_path = ''
set statement_timeout = '5s'
as $$
  select aaro_private.save_workspace_v1(p_expected_revision, p_snapshot);
$$;
revoke all on function public.aaro_workspace_snapshot_valid_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.aaro_save_workspace_v1(bigint,jsonb) from public, anon, authenticated, service_role;
revoke all on function aaro_private.customer_is_confirmed_v1() from public, anon, authenticated, service_role;
revoke all on function aaro_private.save_workspace_v1(bigint,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.aaro_workspace_snapshot_valid_v1(jsonb) to authenticated;
grant execute on function public.aaro_save_workspace_v1(bigint,jsonb) to authenticated;
grant usage on schema aaro_private to authenticated;
grant execute on function aaro_private.customer_is_confirmed_v1() to authenticated;
grant execute on function aaro_private.save_workspace_v1(bigint,jsonb) to authenticated;

-- Definer code remains in the non-exposed aaro_private schema; every lookup or
-- mutation derives/checks auth.uid() and uses fixed relations. No user_metadata,
-- privileged browser key, arbitrary SQL, or unverified session_id claim is used.
-- Owner lane must verify aaro_private is NOT in the Data API exposed schema list.
commit;

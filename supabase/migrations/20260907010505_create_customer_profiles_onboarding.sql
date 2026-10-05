
create table if not exists public.customer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  company_name text,
  role text,
  use_case text,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_profiles enable row level security;

drop policy if exists "customers_can_read_own_profile" on public.customer_profiles;
create policy "customers_can_read_own_profile"
  on public.customer_profiles for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "customers_can_insert_own_profile" on public.customer_profiles;
create policy "customers_can_insert_own_profile"
  on public.customer_profiles for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "customers_can_update_own_profile" on public.customer_profiles;
create policy "customers_can_update_own_profile"
  on public.customer_profiles for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.handle_new_customer_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_customer_profile() from public;

drop trigger if exists on_auth_user_created_customer_profile on auth.users;
create trigger on_auth_user_created_customer_profile
  after insert on auth.users
  for each row execute procedure public.handle_new_customer_profile();

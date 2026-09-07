alter table public.customer_profiles
  add column if not exists onboarding_data jsonb not null default '{}'::jsonb;

comment on column public.customer_profiles.onboarding_data is
  'Validated customer onboarding preferences owned by the authenticated profile row.';

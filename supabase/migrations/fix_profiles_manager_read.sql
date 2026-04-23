-- Fix: managers cannot read other employees' profiles via timesheets join.
-- timesheets.employee_id → profiles.id (FK), but profiles RLS only allows
-- users to read their own row. This breaks employee name display in the
-- timesheet entries table and active shifts panel.
--
-- Uses a SECURITY DEFINER function to avoid infinite recursion when a
-- profiles policy queries the profiles table to check the caller's role.
--
-- Run once in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste → Run

create or replace function public.current_user_is_manager()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id   = auth.uid()
      and role = 'manager'
  )
$$;

-- Allow managers to read all profiles (their own row is already covered by
-- existing "profiles: own read" policy; this adds the manager-wide read)
create policy "managers_can_read_all_profiles"
  on public.profiles
  for select
  using (public.current_user_is_manager());

-- Fix: managers cannot SELECT from the employees table.
-- RLS is enabled on employees but no SELECT policy exists for authenticated users,
-- so every query via the anon key returns [] silently.
--
-- Run this once in your Supabase SQL editor:
--   Dashboard → SQL Editor → New query → paste → Run

-- Allow managers to read all employee rows
create policy "managers_can_select_employees"
  on public.employees
  for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id  = auth.uid()
        and profiles.role = 'manager'
    )
  );

-- Allow each employee to read their own row
create policy "employees_can_select_own"
  on public.employees
  for select
  using (auth.uid() = id);

-- Fix: managers cannot UPDATE the employees table.
-- Without this, deactivate/reactivate and edit employee (pay rates, role) all
-- silently succeed (no error) but update 0 rows.
--
-- Run once in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste → Run

create policy "managers_can_update_employees"
  on public.employees
  for update
  using (
    exists (
      select 1 from public.profiles
      where profiles.id  = auth.uid()
        and profiles.role = 'manager'
    )
  );

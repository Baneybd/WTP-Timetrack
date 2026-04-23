-- Fix: "Promote to Manager" updates employees.role but not profiles.role.
-- auth.js checks profiles.role for dashboard access, so without this trigger
-- the promoted employee still lands on employee.html after next login.
--
-- Run once in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste → Run

create or replace function sync_employee_role_to_profile()
returns trigger as $$
begin
  update public.profiles set role = NEW.role where id = NEW.id;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger sync_role_after_employee_update
  after update of role on public.employees
  for each row
  when (OLD.role is distinct from NEW.role)
  execute function sync_employee_role_to_profile();

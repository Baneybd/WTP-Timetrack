-- Fix: When a new employee is inserted with role='manager', profiles.role was
-- not being updated because the existing sync trigger only fires on UPDATE.
-- This adds an AFTER INSERT trigger so new employees also sync their role
-- to profiles, regardless of whether the edge function's upsert succeeded.
--
-- Run once in Supabase SQL Editor.

create or replace function sync_employee_role_to_profile_on_insert()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, role)
  values (NEW.id, NEW.full_name, NEW.role)
  on conflict (id) do update set role = NEW.role;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger sync_role_after_employee_insert
  after insert on public.employees
  for each row
  execute function sync_employee_role_to_profile_on_insert();

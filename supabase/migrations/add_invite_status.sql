-- Add invite_status to employees table.
-- 'pending' = invite sent, employee has not yet set their password.
-- 'active'  = employee has accepted the invite and logged in.
--
-- Existing employees are marked 'active' (they already have passwords).
-- Run once in Supabase SQL Editor.

alter table public.employees
  add column if not exists invite_status text not null default 'active'
  check (invite_status in ('pending', 'active'));

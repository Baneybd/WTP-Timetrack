-- Fix: employees cannot clock in/out, managers cannot see all timesheets.
-- RLS is enabled on timesheets but policies are missing or incomplete.
--
-- Run once in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste → Run

-- Managers: read all timesheets (active shifts panel, entries table)
create policy "managers_can_select_timesheets"
  on public.timesheets
  for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id  = auth.uid()
        and profiles.role = 'manager'
    )
  );

-- Employees: read their own timesheets (recent entries on employee dashboard)
create policy "employees_can_select_own_timesheets"
  on public.timesheets
  for select
  using (auth.uid() = employee_id);

-- Employees: clock in (insert their own row)
create policy "employees_can_insert_own_timesheets"
  on public.timesheets
  for insert
  with check (auth.uid() = employee_id);

-- Employees: clock out (update their own in_progress row)
create policy "employees_can_update_own_timesheets"
  on public.timesheets
  for update
  using (auth.uid() = employee_id);

-- Managers: insert timesheets for any employee (past entry creation)
create policy "managers_can_insert_timesheets"
  on public.timesheets
  for insert
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id  = auth.uid()
        and profiles.role = 'manager'
    )
  );

-- Managers: update any timesheet (clock out, force clock out, approve, edit)
create policy "managers_can_update_timesheets"
  on public.timesheets
  for update
  using (
    exists (
      select 1 from public.profiles
      where profiles.id  = auth.uid()
        and profiles.role = 'manager'
    )
  );

-- Managers: delete any timesheet
create policy "managers_can_delete_timesheets"
  on public.timesheets
  for delete
  using (
    exists (
      select 1 from public.profiles
      where profiles.id  = auth.uid()
        and profiles.role = 'manager'
    )
  );

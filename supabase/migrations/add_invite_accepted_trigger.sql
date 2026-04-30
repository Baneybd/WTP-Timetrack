-- Automatically flip employees.invite_status → 'active' when the employee
-- confirms their email (i.e. clicks the invite link and sets their password).
-- Done server-side because the employee RLS UPDATE policy does not allow
-- self-updates, so a client-side update would silently fail.

CREATE OR REPLACE FUNCTION handle_invite_accepted()
RETURNS trigger AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.employees
    SET invite_status = 'active'
    WHERE id = NEW.id AND invite_status = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_invite_accepted
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_invite_accepted();

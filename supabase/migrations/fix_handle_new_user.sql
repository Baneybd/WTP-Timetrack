-- Fix the handle_new_user trigger so it includes email (and role from metadata)
-- when creating profiles rows during any auth user creation (createUser, inviteUserByEmail, etc).
-- The missing email was causing a NOT NULL violation on every invite.
--
-- Run once in Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, email)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    COALESCE(new.raw_user_meta_data->>'role', 'employee'),
    new.email
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    role      = EXCLUDED.role,
    email     = EXCLUDED.email;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

/**
 * auth.js — Shared authentication helper
 * Requires: supabase-config.js loaded first, @supabase/supabase-js@2 CDN
 */
const WTPAuth = (() => {
  'use strict';

  const _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /**
   * Sign in with email + password.
   * Returns { user, employee } or throws on error.
   */
  async function signIn(email, password) {
    const { data, error } = await _supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const { data: emp, error: empErr } = await _supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();
    if (empErr) throw new Error('No employee profile found. Contact your manager.');

    return { user: data.user, employee: emp };
  }

  /** Sign out and redirect to login page. */
  async function signOut() {
    await _supabase.auth.signOut();
    window.location.href = 'index.html';
  }

  /**
   * Get current session.
   * Returns { user, employee } or null if not authenticated.
   */
  async function getSession() {
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session) return null;

    const { data: emp } = await _supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();
    if (!emp) return null;

    return { user: session.user, employee: emp };
  }

  /**
   * Enforce role-based access. Call on every protected page load.
   * Redirects to login if unauthenticated, or to the correct page if wrong role.
   * Returns the session { user, employee } on success, or null (after redirect).
   */
  async function requireRole(requiredRole) {
    const session = await getSession();
    if (!session) {
      window.location.href = 'index.html';
      return null;
    }
    if (session.employee.role !== requiredRole) {
      window.location.href = session.employee.role === 'manager' ? 'manager.html' : 'employee.html';
      return null;
    }
    return session;
  }

  return { signIn, signOut, getSession, requireRole, _supabase };
})();

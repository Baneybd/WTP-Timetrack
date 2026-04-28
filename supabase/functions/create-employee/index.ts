// supabase/functions/create-employee/index.ts
// Deployed via: supabase functions deploy create-employee --no-verify-jwt
//
// Called by manager.html to invite a new user via email.
// Requires the caller to be a manager.
// No password is collected — the employee sets their own via the invite link.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header.')

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: caller }, error: userErr } = await supabaseClient.auth.getUser()
    if (userErr || !caller) throw new Error('Not authenticated.')

    const { data: callerProfile, error: profileErr } = await supabaseClient
      .from('profiles')
      .select('role')
      .eq('id', caller.id)
      .single()
    if (profileErr || callerProfile?.role !== 'manager') {
      throw new Error('Not authorized. Only managers can invite employees.')
    }

    const {
      full_name,
      email,
      role = 'employee',
      redirect_to,
    } = await req.json()

    if (!full_name || !email) {
      throw new Error('full_name and email are required.')
    }
    if (!['employee', 'manager'].includes(role)) {
      throw new Error('role must be "employee" or "manager".')
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Send invite email — employee sets their own password via the link
    const inviteRedirect = redirect_to || `${Deno.env.get('APP_URL') || ''}/set-password.html`
    const { data: newUser, error: authError } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo: inviteRedirect,
        data: { full_name, role },
      }
    )
    if (authError) throw authError

    // Set profiles.role explicitly — fatal if this fails, since it controls dashboard access.
    // The INSERT trigger on employees (fix_role_sync_on_insert.sql) provides a second guarantee,
    // but this explicit upsert runs first and must succeed.
    const { error: profileUpsertErr } = await adminClient
      .from('profiles')
      .upsert({ id: newUser.user.id, full_name, role }, { onConflict: 'id' })
    if (profileUpsertErr) {
      await adminClient.auth.admin.deleteUser(newUser.user.id)
      throw new Error(`Failed to set profile role: ${profileUpsertErr.message}`)
    }

    // Insert the employees row (INSERT trigger will re-sync role as a backstop)
    const { data: employee, error: empError } = await adminClient
      .from('employees')
      .insert({
        id:             newUser.user.id,
        auth_id:        newUser.user.id,
        full_name,
        email,
        role,
        is_active:      true,
        invite_status:  'pending',
      })
      .select()
      .single()
    if (empError) {
      await adminClient.auth.admin.deleteUser(newUser.user.id)
      throw empError
    }

    return new Response(JSON.stringify(employee), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'An unexpected error occurred.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    )
  }
})

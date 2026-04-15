// supabase/functions/create-employee/index.ts
// Deployed via: supabase functions deploy create-employee --no-verify-jwt
//
// Called by manager.html to create a new Supabase Auth user and
// link them to the employees table. Requires the caller to be a manager.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify the calling user is authenticated and is a manager
    const authHeader = req.headers.get('Authorization')!
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
      throw new Error('Not authorized. Only managers can create employee accounts.')
    }

    // Parse request body
    const {
      full_name,
      email,
      password,
      role = 'employee',
      pay_rate_regular = 25.00,
      pay_rate_overtime = 37.50,
      pay_rate_doubletime = 50.00,
      pay_rate_holiday = 50.00,
    } = await req.json()

    if (!full_name || !email || !password) {
      throw new Error('full_name, email, and password are required.')
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters.')
    }

    // Use service role key to create the auth user (bypasses email confirmation)
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: newUser, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (authError) throw authError

    // Insert the employee profile, linked to the new auth user
    const { data: employee, error: empError } = await adminClient
      .from('employees')
      .insert({
        auth_id:             newUser.user.id,
        full_name,
        email,
        role,
        pay_rate_regular,
        pay_rate_overtime,
        pay_rate_doubletime,
        pay_rate_holiday,
      })
      .select()
      .single()
    if (empError) {
      // Roll back auth user if employee insert fails
      await adminClient.auth.admin.deleteUser(newUser.user.id)
      throw empError
    }

    return new Response(JSON.stringify(employee), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || 'An unexpected error occurred.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    )
  }
})

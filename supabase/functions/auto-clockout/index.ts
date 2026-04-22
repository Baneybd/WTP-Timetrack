// supabase/functions/auto-clockout/index.ts
// Clocks out all employees still active at 4:00 AM.
// Called by pg_cron (runs at 2:00 AM server time — adjust UTC offset for your timezone):
//   SELECT cron.schedule('wtp-auto-clockout', '0 2 * * *',
//     $$SELECT net.http_post(url:='https://<project-ref>.supabase.co/functions/v1/auto-clockout',
//       headers:='{"Authorization":"Bearer <service-role-key>"}'::jsonb)$$);
//
// Or trigger manually: POST /functions/v1/auto-clockout with service-role key.
// Deploy: supabase functions deploy auto-clockout --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    // Only callable with service-role key or from pg_cron
    const authHeader = req.headers.get('Authorization') || ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    if (!authHeader.includes(serviceRoleKey)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      serviceRoleKey
    )

    // Find all active (in_progress) shifts
    const { data: activeShifts, error: fetchErr } = await adminClient
      .from('timesheets')
      .select('id, employee_id, created_at, kimai_timesheet_id')
      .eq('status', 'in_progress')

    if (fetchErr) throw fetchErr
    if (!activeShifts || activeShifts.length === 0) {
      return new Response(JSON.stringify({ clocked_out: 0, message: 'No active shifts.' }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    // 2:00 AM cutoff — use the current day at 02:00 local server time
    const now = new Date()
    const cutoff = new Date(now)
    cutoff.setHours(2, 0, 0, 0)

    // Try to stop Kimai timers (best-effort)
    const kimaiConfig = await adminClient
      .from('kimai_config')
      .select('base_url, token')
      .maybeSingle()

    const results: Array<{ id: string; hours: number; error?: string }> = []

    for (const shift of activeShifts) {
      try {
        const clockIn   = new Date(shift.created_at)
        const rawHours  = (cutoff.getTime() - clockIn.getTime()) / 3600000
        const hours     = Math.max(Math.round(rawHours * 4) / 4, 0.25)

        // Attempt Kimai stop (non-fatal)
        if (shift.kimai_timesheet_id && kimaiConfig.data?.base_url) {
          try {
            await fetch(`${kimaiConfig.data.base_url}/api/timesheets/${shift.kimai_timesheet_id}/stop`, {
              method: 'PATCH',
              headers: {
                'Authorization': 'Bearer ' + kimaiConfig.data.token,
                'Content-Type': 'application/json',
              },
            })
          } catch (_) { /* non-fatal */ }
        }

        // Update to completed with auto_clocked_out = true
        const { error: updateErr } = await adminClient
          .from('timesheets')
          .update({
            status:           'completed',
            auto_clocked_out: true,
            end_time:         '02:00:00',
            hours_worked:     hours,
          })
          .eq('id', shift.id)

        if (updateErr) throw updateErr
        results.push({ id: shift.id, hours })
      } catch (err) {
        results.push({ id: shift.id, hours: 0, error: (err as Error).message })
      }
    }

    return new Response(JSON.stringify({ clocked_out: results.length, results }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})

// supabase/functions/kimai-timer/index.ts
// Proxies clock-in / clock-out calls to Kimai, keeping the admin token server-side.
// Deploy: supabase functions deploy kimai-timer --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // ── Verify Supabase session ──────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')!;
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    // ── Fetch Kimai config from DB (requires service role) ───────────────────
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: config } = await adminClient
      .from('kimai_config')
      .select('base_url, token')
      .single();
    if (!config) throw new Error('Kimai not configured — ask your manager to set the Kimai URL and token.');

    const { action, timesheetId, payload } = await req.json();

    const kimaiHeaders = {
      'Authorization': 'Bearer ' + config.token,
      'Content-Type': 'application/json',
    };

    let kimaiResp: Response;

    if (action === 'start') {
      // Clock in — create a running timesheet in Kimai
      kimaiResp = await fetch(`${config.base_url}/api/timesheets`, {
        method: 'POST',
        headers: kimaiHeaders,
        body: JSON.stringify(payload), // { begin, project, activity, tags, billable }
      });
    } else if (action === 'stop') {
      // Clock out — stop the running timer
      kimaiResp = await fetch(`${config.base_url}/api/timesheets/${timesheetId}/stop`, {
        method: 'PATCH',
        headers: kimaiHeaders,
      });
    } else if (action === 'ping') {
      // Connection test — just verify we can reach Kimai
      kimaiResp = await fetch(`${config.base_url}/api/version`, { headers: kimaiHeaders });
    } else {
      throw new Error('Unknown action: ' + action);
    }

    if (!kimaiResp.ok) {
      const err = await kimaiResp.text();
      throw new Error(`Kimai error (${kimaiResp.status}): ${err}`);
    }

    const result = kimaiResp.status === 204 ? {} : await kimaiResp.json();
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
});

// kimai-config.js
// All Kimai calls are proxied through the Supabase Edge Function so the
// Kimai admin token is never exposed to the browser.
// Replace YOUR_PROJECT_REF with your actual Supabase project reference ID.
const KIMAI_EDGE_FN = 'https://xyjzsoohquripymrkipr.supabase.co/functions/v1/kimai-timer';

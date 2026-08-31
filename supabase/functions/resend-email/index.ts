// Supabase Edge Function — resend-email
//
// Sends outgoing mail (subcontract agreements, RFIs, EOTs, invoices…) on behalf of the app.
// The mail-provider API key lives here as a server-side secret. It must NEVER be put in
// index.html: that file is public, so anyone could read the key and send mail as you.
//
// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------
// 1. Create a Resend account (https://resend.com) and verify your sending domain
//    (cubiccm.com). Until a domain is verified Resend only allows sending to your
//    own address, which is fine for testing.
// 2. Create an API key, then store it as a secret:
//       supabase secrets set RESEND_API_KEY=re_xxxxxxxx
//       supabase secrets set MAIL_FROM="CUBIC Construction Management <no-reply@cubiccm.com>"
// 3. Deploy:
//       supabase functions deploy resend-email --no-verify-jwt
//
// Request body: { to: string[], cc?: string[], subject: string, text: string,
//                 attachments?: { name: string, url: string }[] }
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return json({ error: 'RESEND_API_KEY not configured' }, 500);
  const from = Deno.env.get('MAIL_FROM') || 'onboarding@resend.dev';

  // Only signed-in users of this app may send.
  //
  // Deploy this function with --no-verify-jwt. This project signs its tokens
  // asymmetrically and the platform gateway rejects them before the function ever runs
  // (UNAUTHORIZED_ASYMMETRIC_JWT), which is why mail silently fell back to a mail-client
  // handoff. The check therefore happens here, by asking the auth server to validate the
  // token - it does so whatever the token is signed with. Without this the function would
  // be an open mail relay.
  const authz = req.headers.get('Authorization') || '';
  const token = authz.slice(0, 7).toLowerCase() === 'bearer ' ? authz.slice(7) : authz;
  if (!token) return json({ error: 'Not authorised' }, 401);
  const SB_URL = Deno.env.get('SUPABASE_URL');
  const SB_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
  if (SB_URL) {
    const who = await fetch(SB_URL + '/auth/v1/user', {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
    });
    if (!who.ok) return json({ error: 'Not authorised' }, 401);
  }

  let payload: { to?: string[]; cc?: string[]; subject?: string; text?: string; attachments?: { name: string; url: string }[] };
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const to = (payload.to || []).filter(Boolean);
  if (!to.length) return json({ error: 'No recipients' }, 400);
  // Anyone deliberately copied in was being dropped here: the app sends cc, this never read it.
  const cc = (payload.cc || []).filter(Boolean);

  // Pull each attachment and inline it as base64 so the recipient gets the real file.
  const attachments: { filename: string; content: string }[] = [];
  for (const a of (payload.attachments || []).slice(0, 10)) {
    try {
      const r = await fetch(a.url);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      attachments.push({ filename: a.name || 'attachment', content: btoa(bin) });
    } catch { /* skip an attachment we can't fetch rather than failing the whole send */ }
  }

  const text = payload.text || '';
  const html = '<div style="font-family:Archivo,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#1D2330;white-space:pre-wrap">'
    + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    + '</div>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ from, to, subject: payload.subject || '(no subject)', text, html, attachments }, cc.length ? { cc } : {})),
  });

  const body = await res.text();
  if (!res.ok) return json({ error: 'Mail provider rejected the send', detail: body }, 502);
  return json({ ok: true, sent: to.length, cc: cc.length, attachments: attachments.length, provider: body });
});

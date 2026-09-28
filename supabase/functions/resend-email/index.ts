// Supabase Edge Function — resend-email
//
// Sends outgoing mail (subcontract agreements, RFIs, EOTs, invoices…) on behalf of the app.
// Provider secrets live here, server-side. They must NEVER be put in index.html: that file is
// public, so anyone could read them and send mail as you.
//
// Two ways to send, chosen by which secrets are set:
//
//  1. Through a Google Workspace mailbox  (no DNS needed — used whenever it is set up)
//     A small Apps Script (gmail-sender.gs) in the mailbox sends each email as that mailbox, or as
//     one of its Gmail "Send mail as" addresses, with the attachments, and it lands in Sent.
//     Set up with:
//       powershell -ExecutionPolicy Bypass -File supabase\functions\resend-email\make-gmail-sender.ps1
//     Secrets: GMAIL_SEND_URL (the script's Web app URL), GMAIL_SEND_KEY (shared with the script).
//
//  2. Through Resend  (needs the sending domain verified by DNS in Resend)
//     Secrets: RESEND_API_KEY, MAIL_FROM.
//
// Deploy:  supabase functions deploy resend-email --no-verify-jwt
//
// Request body: { to: string[], cc?: string[], subject: string, text: string,
//                 from?: string, fromName?: string, attachments?: { name: string, url: string }[] }
// `from` is who the email should come from and who replies should reach. It defaults to the
// signed-in user's own address.
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const gmailUrl = Deno.env.get('GMAIL_SEND_URL') || '';
  const gmailKey = Deno.env.get('GMAIL_SEND_KEY') || '';
  const useGmail = !!(gmailUrl && gmailKey);
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!useGmail && !apiKey) return json({ error: 'No mail provider is set up on the server (neither the Gmail sender nor RESEND_API_KEY).' }, 500);

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
  let userEmail = '';
  if (SB_URL) {
    const who = await fetch(SB_URL + '/auth/v1/user', {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
    });
    if (!who.ok) return json({ error: 'Not authorised' }, 401);
    try { userEmail = String((await who.json()).email || ''); } catch { /* the check passed; the address is only a default */ }
  }

  let payload: { to?: string[]; cc?: string[]; subject?: string; text?: string; from?: string; fromName?: string; attachments?: { name: string; url: string }[] };
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const to = (payload.to || []).filter(Boolean);
  if (!to.length) return json({ error: 'No recipients' }, 400);
  // Anyone deliberately copied in was being dropped here: the app sends cc, this never read it.
  const cc = (payload.cc || []).filter(Boolean);
  const askedFrom = String(payload.from || '').trim();
  const sender = isEmail(askedFrom) ? askedFrom : (isEmail(userEmail) ? userEmail : '');
  const senderName = String(payload.fromName || '').trim();

  // Pull each attachment and inline it as base64 so the recipient gets the real file.
  const attachments: { filename: string; content: string; type: string }[] = [];
  for (const a of (payload.attachments || []).slice(0, 10)) {
    try {
      const r = await fetch(a.url);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      attachments.push({ filename: a.name || 'attachment', content: btoa(bin), type: (r.headers.get('content-type') || 'application/octet-stream').split(';')[0] });
    } catch { /* skip an attachment we can't fetch rather than failing the whole send */ }
  }

  const subject = payload.subject || '(no subject)';
  const text = payload.text || '';
  const html = '<div style="font-family:Archivo,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#1D2330;white-space:pre-wrap">'
    + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    + '</div>';

  if (useGmail) {
    let res: Response;
    try {
      // The web app answers a POST with a redirect to its result; fetch follows it.
      res = await fetch(gmailUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: gmailKey, to, cc, subject, text, html, from: sender, fromName: senderName,
          attachments: attachments.map(a => ({ name: a.filename, mimeType: a.type, data: a.content })) }),
        redirect: 'follow',
      });
    } catch (e) {
      return json({ error: 'The Gmail sender could not be reached.', raw: String(e) }, 502);
    }
    const raw = await res.text();
    let out: { ok?: boolean; error?: string; from?: string; replyTo?: string; leftToday?: number } | null = null;
    try { out = JSON.parse(raw); } catch { out = null; }
    if (!out) {
      return json({ error: 'The Gmail sender did not answer as expected. Check the script is deployed as a Web app with "Who has access: Anyone".', raw: raw.slice(0, 300) }, 502);
    }
    if (!out.ok) return json({ error: 'Gmail did not send it: ' + (out.error || 'no reason given') }, 502);
    return json({ ok: true, via: 'gmail', sent: to.length, cc: cc.length, attachments: attachments.length, from: out.from, replyTo: out.replyTo, leftToday: out.leftToday });
  }

  const from = Deno.env.get('MAIL_FROM') || 'onboarding@resend.dev';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign(
      { from, to, subject, text, html, attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) },
      cc.length ? { cc } : {},
      sender ? { reply_to: sender } : {})),
  });

  const body = await res.text();
  if (!res.ok) return json({ error: 'Mail provider rejected the send', detail: body }, 502);
  return json({ ok: true, via: 'resend', sent: to.length, cc: cc.length, attachments: attachments.length, provider: body });
});

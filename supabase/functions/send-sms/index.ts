// Supabase Edge Function — send-sms
//
// Sends text messages on behalf of the app (meeting invitations, "an invoice is waiting",
// "the agreement is ready to sign"). The provider credentials live here as server-side
// secrets. They must NEVER be put in index.html: that file is public, so anyone could read
// them and send messages billed to this account.
//
// Until this is deployed and configured the app falls back to handing each message to the
// device — a link that opens the phone's Messages app, or WhatsApp — so nothing is blocked
// on it, but nothing is automatic either.
//
// ---------------------------------------------------------------------------
// One-time setup (Twilio)
// ---------------------------------------------------------------------------
// 1. Create a Twilio account and either buy a number that can send to Australia or register
//    an alphanumeric sender ID (a short name such as CUBICPM — cheaper, and recipients
//    cannot reply to it).
// 2. Store the credentials as secrets. Do not paste them into a chat or a commit:
//       supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxx
//       supabase secrets set TWILIO_AUTH_TOKEN=xxxxxxxx
//       supabase secrets set TWILIO_FROM="CUBICPM"        # or +61XXXXXXXXX
// 3. Deploy:
//       supabase functions deploy send-sms --no-verify-jwt
//
// Request body: { to: string[], text: string }
// Numbers must already be in E.164 (+61412345678). The app normalises them before sending.
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

  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');
  if (!sid || !token || !from) {
    // A clear answer rather than a generic 500: the app shows this text to the user, and
    // "not configured" is the one failure they can actually do something about.
    return json({ error: 'No text-message provider is configured on the server yet.' }, 500);
  }

  // Only signed-in users of this app may send. Deployed with --no-verify-jwt for the same
  // reason as resend-email: this project signs its tokens asymmetrically and the platform
  // gateway rejects them before the function runs, so the check happens here by asking the
  // auth server to validate the token. Without this the function would be an open SMS relay
  // that anyone on the internet could run up a bill on.
  const authz = req.headers.get('Authorization') || '';
  const jwt = authz.slice(0, 7).toLowerCase() === 'bearer ' ? authz.slice(7) : authz;
  if (!jwt) return json({ error: 'Not authorised' }, 401);
  const SB_URL = Deno.env.get('SUPABASE_URL');
  const SB_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
  if (SB_URL) {
    const who = await fetch(SB_URL + '/auth/v1/user', {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + jwt },
    });
    if (!who.ok) return json({ error: 'Not authorised' }, 401);
  }

  let payload: { to?: string[]; text?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  // Only E.164. A number in local form reaches nobody and is billed as a failed send, so it
  // is refused here rather than passed on.
  const to = (payload.to || []).map(n => String(n || '').trim()).filter(n => /^\+[1-9]\d{7,14}$/.test(n));
  const text = String(payload.text || '').trim();
  if (!to.length) return json({ error: 'No recipients in international format (+61…)' }, 400);
  if (!text) return json({ error: 'No message text' }, 400);
  // One message per recipient, and a hard ceiling so a loop in the app cannot become a bill.
  if (to.length > 25) return json({ error: 'Too many recipients in one send (max 25)' }, 400);

  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
  const auth = 'Basic ' + btoa(sid + ':' + token);

  const results = await Promise.all(to.map(async (number) => {
    const body = new URLSearchParams({ To: number, From: from, Body: text });
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const detail = await r.text();
      return { to: number, ok: r.ok, status: r.status, detail: r.ok ? '' : detail.slice(0, 400) };
    } catch (e) {
      return { to: number, ok: false, status: 0, detail: String(e).slice(0, 200) };
    }
  }));

  const sent = results.filter(r => r.ok);
  // A partial failure is still a failure worth reporting: the app tells the user which
  // numbers did not go, rather than saying everything was sent.
  if (!sent.length) return json({ error: 'No message could be sent', detail: results[0]?.detail || '', results }, 502);
  return json({ ok: true, sent: sent.length, of: to.length, results });
});

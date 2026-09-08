// Supabase Edge Function — inbound-email
//
// Receives a supplier's email and writes it, whole, into public.ap_inbox. The app collects it
// from there and reads it with the same parser it uses for an uploaded .eml, so an emailed
// invoice and a dropped file travel one road.
//
// This function does not parse, judge or match anything. The message is kept exactly as it
// arrived, because every rule that decides whose invoice this is reads the message itself, and a
// rule improved next year should be able to read the same text again.
//
// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------
// 1. Run supabase/migrations/20260909_ap_inbox.sql in the SQL Editor.
// 2. Invent a long random string — this is the only thing standing between the open internet
//    and your invoice queue — and store it, along with which addresses you are willing to
//    receive at:
//       supabase secrets set INBOUND_KEY=<a long random string>
//       supabase secrets set INBOUND_TO=sydneylvl.com
// 3. Deploy. --no-verify-jwt is required: a mail provider's webhook has no Supabase token to
//    send, which is why this function checks INBOUND_KEY itself.
//       supabase functions deploy inbound-email --no-verify-jwt
// 4. Point a mail provider at it. See README.md in this folder.
//
// The URL to give the provider:
//   https://<project>.supabase.co/functions/v1/inbound-email?key=<INBOUND_KEY>
//
// ---------------------------------------------------------------------------
// What it accepts
// ---------------------------------------------------------------------------
// The contract is "give me the whole message", in whichever way your provider sends it:
//   * a body of Content-Type message/rfc822 or text/plain — the raw MIME
//   * multipart/form-data with the raw message in a field named email, body-mime, message or raw
//   * JSON with the raw message in raw, mime, RawEmail, body-mime or message
//   * Resend's email.received webhook, which announces an arrival rather than delivering it —
//     the message is then fetched from Resend, using RESEND_API_KEY (already set for the
//     resend-email function; secrets are shared across a project)
// If none of those is present, the parsed pieces a provider sends instead (from, to, subject,
// text, html, attachments) are reassembled into a MIME message, so the app still sees one shape.
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-inbound-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Longest plausible message. A scanned invoice is a megabyte or two; twenty is somebody mailing
// a photo album. Over the limit the message is still recorded, as a failure with a reason, so
// that it shows up in the app instead of disappearing.
const MAX_BYTES = Number(Deno.env.get('INBOUND_MAX_BYTES') || '') || 20 * 1024 * 1024;

// Compared to the key in the query string. Same length every time, so the comparison itself
// gives nothing away about how much of a guess was right.
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const addr = (s: string): string => {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
};

const headerOf = (raw: string, name: string): string => {
  // Headers stop at the first blank line, and a long one is continued by an indented line.
  const head = raw.split(/\r?\n\r?\n/)[0] || '';
  const re = new RegExp('^' + name + ':[ \\t]*([\\s\\S]*?)(?=\\r?\\n[^ \\t]|$)', 'im');
  const m = head.match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
};

const pick = (o: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
};

// Providers that hand over the parsed pieces instead of the message get the message built back
// from them. One shape reaches the app either way.
function rebuild(from: string, to: string, subject: string, text: string, html: string,
                 atts: { name: string; type: string; b64: string }[]): string {
  const b = 'cpms' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const L: string[] = [
    'From: ' + (from || 'unknown@invalid'),
    'To: ' + (to || 'unknown@invalid'),
    'Subject: ' + (subject || ''),
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + b + '"',
    '',
    '--' + b,
    'Content-Type: ' + (text || !html ? 'text/plain' : 'text/html') + '; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text || html || '',
  ];
  for (const a of atts) {
    L.push('--' + b);
    L.push('Content-Type: ' + (a.type || 'application/octet-stream') + '; name="' + a.name + '"');
    L.push('Content-Transfer-Encoding: base64');
    L.push('Content-Disposition: attachment; filename="' + a.name + '"');
    L.push('');
    // 76-character lines: some readers refuse a base64 body that is one very long line.
    L.push((a.b64 || '').replace(/\s+/g, '').replace(/(.{76})/g, '$1\n'));
  }
  L.push('--' + b + '--');
  L.push('');
  return L.join('\r\n');
}

// Resend's webhook carries metadata only: the body and the attachments stay on their side until
// they are asked for. So they are asked for here. The record it returns names a signed URL for
// the raw MIME, which is the whole message byte for byte and exactly what everything downstream
// wants — the parsed pieces are only a fallback for the case where that URL is not there.
async function fromResend(id: string): Promise<string> {
  const key = Deno.env.get('RESEND_API_KEY') || '';
  if (!key) throw new Error('RESEND_API_KEY is not set, so the message cannot be fetched');
  const meta = await fetch('https://api.resend.com/emails/receiving/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + key },
  });
  if (!meta.ok) throw new Error('Resend would not hand over ' + id + ': ' + meta.status);
  const body = await meta.json() as Record<string, unknown>;

  const rawInfo = body.raw as Record<string, unknown> | undefined;
  const url = rawInfo && typeof rawInfo.download_url === 'string' ? rawInfo.download_url : '';
  if (url) {
    const got = await fetch(url);
    if (got.ok) return await got.text();
  }

  // Without the raw message the attachments cannot come with it. The invoice is still recorded
  // rather than dropped: with "only mail carrying an attachment" switched on it lands under Not
  // collected, which is a thing somebody can see, unlike silence.
  const to = Array.isArray(body.to) ? (body.to as unknown[]).map(String).join(', ') : String(body.to || '');
  return rebuild(String(body.from || ''), to, String(body.subject || ''),
    String(body.text || ''), String(body.html || ''), []);
}

async function readMessage(req: Request): Promise<string> {
  const ctype = (req.headers.get('content-type') || '').toLowerCase();

  if (ctype.includes('message/rfc822') || ctype.startsWith('text/plain') || !ctype) {
    return await req.text();
  }

  if (ctype.includes('multipart/form-data')) {
    const form = await req.formData();
    for (const k of ['email', 'body-mime', 'message', 'raw']) {
      const v = form.get(k);
      if (typeof v === 'string' && v.trim()) return v;
      if (v instanceof File) return await v.text();
    }
    const atts: { name: string; type: string; b64: string }[] = [];
    for (const [, v] of form.entries()) {
      if (v instanceof File && v.name) {
        const buf = new Uint8Array(await v.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        atts.push({ name: v.name, type: v.type || 'application/octet-stream', b64: btoa(s) });
      }
    }
    const g = (k: string) => String(form.get(k) || '');
    return rebuild(g('from') || g('sender'), g('to') || g('recipient'), g('subject'),
      g('text') || g('body-plain') || g('TextBody'), g('html') || g('body-html') || g('HtmlBody'), atts);
  }

  // JSON, or something calling itself JSON.
  const body = await req.text();
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(body) as Record<string, unknown>; } catch { return body; }
  // A webhook that wraps its payload — Resend sends { type, data: {...} }.
  const d = (o.data && typeof o.data === 'object' ? o.data as Record<string, unknown> : o);
  const raw = pick(d, ['raw', 'mime', 'RawEmail', 'body-mime', 'message', 'rawEmail']);
  if (raw) return raw;

  // Resend announces an arrival rather than delivering it. Go and get it.
  const resendId = pick(d, ['email_id', 'emailId']);
  if (resendId && String(o.type || '').indexOf('received') >= 0) return await fromResend(resendId);

  const list = (d.attachments || d.Attachments || []) as Record<string, unknown>[];
  const atts = (Array.isArray(list) ? list : []).map(a => ({
    name: String(a.name || a.Name || a.filename || 'attachment'),
    type: String(a.type || a.ContentType || a.content_type || 'application/octet-stream'),
    b64: String(a.content || a.Content || a.data || a.content_base64 || ''),
  })).filter(a => a.b64);

  const toField = d.to || d.To;
  const toStr = Array.isArray(toField) ? toField.map(x => String((x as Record<string, unknown>)?.address || x)).join(', ') : String(toField || '');
  const fromField = d.from || d.From;
  const fromStr = typeof fromField === 'object' && fromField
    ? String((fromField as Record<string, unknown>).address || '')
    : String(fromField || '');

  return rebuild(fromStr, toStr, pick(d, ['subject', 'Subject']),
    pick(d, ['text', 'TextBody', 'body-plain', 'plain']),
    pick(d, ['html', 'HtmlBody', 'body-html']), atts);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const secret = Deno.env.get('INBOUND_KEY') || '';
  if (!secret) return json({ error: 'INBOUND_KEY not configured' }, 500);
  const url = new URL(req.url);
  const given = url.searchParams.get('key') || req.headers.get('x-inbound-key') || '';
  if (!sameSecret(secret, given)) return json({ error: 'Not authorised' }, 401);

  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SB_URL || !SB_SERVICE) return json({ error: 'Supabase credentials not configured' }, 500);

  let raw = '';
  try { raw = await readMessage(req); } catch { return json({ error: 'Could not read the message' }, 400); }
  raw = String(raw || '');
  if (!raw.trim()) return json({ error: 'Empty message' }, 400);

  const size = new TextEncoder().encode(raw).length;
  const tooBig = size > MAX_BYTES;

  // Envelope first, headers second. A provider knows which address it actually delivered to;
  // the To: header can say anything, and on a forward it usually says somebody else.
  const envTo = addr(url.searchParams.get('to') || req.headers.get('x-inbound-to') || '');
  const to = envTo || addr(headerOf(raw, 'To'));
  const from = addr(headerOf(raw, 'From'));
  const subject = headerOf(raw, 'Subject').slice(0, 500);
  const messageId = headerOf(raw, 'Message-ID').replace(/^<|>$/g, '').slice(0, 400);

  // Which addresses this company is willing to receive invoices at. Empty accepts anything, but
  // the setup notes ask for a domain, because a URL that leaks should not become a way to put
  // documents in front of the accounts team.
  const allow = (Deno.env.get('INBOUND_TO') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && to) {
    const dom = to.split('@')[1] || '';
    if (!allow.some(a => a === to || a === dom || a === '@' + dom)) {
      // Not an error on the provider's part, so not an error code: nothing should be retried.
      return json({ ok: true, ignored: 'not a receiving address', to }, 200);
    }
  }

  const row = {
    to_addr: to, from_addr: from, subject, message_id: messageId,
    size_bytes: size,
    raw: tooBig ? '' : raw,
    status: tooBig ? 'failed' : 'new',
    note: tooBig ? ('The message was ' + Math.round(size / 1048576) + 'MB, over the ' + Math.round(MAX_BYTES / 1048576) + 'MB limit, and was not kept. Ask the sender for the invoice on its own, or upload it by hand.') : '',
  };

  // resolution=ignore-duplicates, with the unique index on message_id, is what makes a provider's
  // retry harmless: the second copy is refused by the database rather than by somebody noticing
  // two identical invoices next week.
  const res = await fetch(SB_URL + '/rest/v1/ap_inbox', {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE,
      Authorization: 'Bearer ' + SB_SERVICE,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify([row]),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // A 500 tells the provider to try again later, which is right: the message is not lost,
    // it simply has not been stored yet.
    return json({ error: 'Could not store the message', detail: detail.slice(0, 400) }, 500);
  }

  const saved = await res.json().catch(() => []);
  const duplicate = Array.isArray(saved) && saved.length === 0;
  return json({ ok: true, stored: !duplicate, duplicate, id: (saved[0] || {}).id || '', to, from, subject, size });
});

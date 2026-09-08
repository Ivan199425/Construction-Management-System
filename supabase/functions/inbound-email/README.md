# Receiving invoices by email

An invoice mailed to your receiving address ends up on the Invoices screen without anybody
touching it. Three pieces make that happen:

```
supplier's email
   -> a mail provider that accepts mail for your domain
   -> POST to the inbound-email function        (this folder)
   -> a row in public.ap_inbox                  (supabase/migrations/20260909_ap_inbox.sql)
   -> the app collects it and reads it exactly as it reads an uploaded .eml
```

Nothing about the message is interpreted on the server. The whole thing is stored as it arrived
and read in the browser by the same parser an upload goes through, so the supplier match, the
project rules, the duplicate check and the "not collected" scope all behave identically whether
the invoice was emailed or dropped in by hand.

---

## Before anything else: do not point the root domain at a mail provider

If `sydneylvl.com` itself is made to receive mail here, **every** address at that domain routes to
this system — `ivan@sydneylvl.com` included, and that mailbox stops arriving where it does now.

Use a subdomain. Two ways, both ending with a tidy address on the main domain:

| | Address suppliers use | What has to change |
|---|---|---|
| **A. Forward** *(recommended)* | `invoices@sydneylvl.com` | Create that mailbox or alias with your existing mail host and forward it to `invoices@inbox.sydneylvl.com`. Your MX stays exactly as it is. |
| **B. Direct** | `invoices@inbox.sydneylvl.com` | Nothing else to set up, but suppliers see the longer address. |

Either way the MX record you add below is on `inbox.sydneylvl.com`, never on `sydneylvl.com`.

---

## 1. The table

Supabase dashboard → SQL Editor → paste `supabase/migrations/20260909_ap_inbox.sql` → Run.

## 2. The secrets

`INBOUND_KEY` is the only thing standing between the open internet and your invoice queue. Make it
long and random.

```bash
supabase secrets set INBOUND_KEY=$(openssl rand -hex 32)
supabase secrets set INBOUND_TO=sydneylvl.com,inbox.sydneylvl.com
supabase functions deploy inbound-email --no-verify-jwt
```

`--no-verify-jwt` is required. A mail provider has no Supabase token to send, which is why the
function checks `INBOUND_KEY` itself rather than relying on the platform gateway.

Your webhook URL is then:

```
https://vzxenkijxzzrgnmopnxh.supabase.co/functions/v1/inbound-email?key=<INBOUND_KEY>
```

## 3. A provider to accept the mail

### Cloudflare Email Routing — free, and hands over the message untouched

Needs `sydneylvl.com` (or at least `inbox.sydneylvl.com`) using Cloudflare for DNS.

1. Cloudflare dashboard → your domain → **Email** → **Email Routing** → enable. It adds the MX
   records for you.
2. **Email Workers** → create a worker, paste `worker.example.js` from this folder, and set the
   variables `ENDPOINT` and `KEY` (Settings → Variables — put `KEY` in as a **secret**).
3. **Routing rules** → send `invoices@…` to that worker.

This route posts the raw MIME straight through: nothing is re-encoded, nothing is summarised.

### Resend — one MX record, wherever your DNS lives

You already use Resend for outgoing mail. Its inbound side delivers **metadata** to a webhook and
keeps the body for retrieval, so it needs a small relay of its own rather than pointing straight
at this function. Use it if moving DNS to Cloudflare is not on.

### Anything else

The function's contract is "give me the whole message". It accepts the raw MIME as a
`message/rfc822` body, as a `multipart/form-data` field named `email`, `body-mime`, `message` or
`raw`, or as a JSON field of the same names — which covers SendGrid Inbound Parse, Mailgun's
raw-MIME store, and Postmark's `RawEmail`. If a provider only sends parsed pieces, they are
reassembled into a message so the app still sees one shape.

## 4. Tell the app

Settings → **Invoice ingestion** → put the receiving address in **Mailbox to watch**, then press
**Check now**. The status pill turns green the first time the app reaches the table.

Setting the address here does one more thing: its domain becomes an *internal* domain, so a
message forwarded by one of your own people is read as a forward, and the supplier is taken from
the message inside rather than from whoever passed it on.

---

## Checking it works, without a supplier

```bash
curl -X POST \
  "https://vzxenkijxzzrgnmopnxh.supabase.co/functions/v1/inbound-email?key=<INBOUND_KEY>" \
  -H "Content-Type: message/rfc822" \
  --data-binary @some-invoice-email.eml
```

A `{"ok":true,"stored":true}` means it is in the table. Press **Check now** in the app and the
invoice appears. Send the same file twice and the second is refused as a duplicate, which is what
should happen when a provider retries.

## When something does not arrive

| What you see | What it means |
|---|---|
| `401 Not authorised` | The `key` in the URL is not `INBOUND_KEY`. |
| `{"ok":true,"ignored":"not a receiving address"}` | The address it was sent to is not in `INBOUND_TO`. |
| Stored, but the app shows nothing | Press **Check now**. If the pill stays amber, the migration has not been run. |
| Arrives under **Not collected** | It was read fine; the rules could not place it on a project. The **Not collected** tab lists it, and **Collect** takes it back. |
| Nothing at all, anywhere | The mail never reached the provider — check the MX record and the routing rule, not this function. |

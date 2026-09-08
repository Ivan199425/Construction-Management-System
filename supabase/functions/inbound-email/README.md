# Receiving invoices by email

An invoice mailed to your receiving address ends up on the Invoices screen without anybody
touching it. Three pieces make that happen:

```
supplier's email
   -> a mail provider that accepts mail for the receiving domain
   -> POST to the inbound-email function        (this folder)
   -> a row in public.ap_inbox                  (supabase/migrations/20260909_ap_inbox.sql)
   -> the app collects it and reads it exactly as it reads an uploaded .eml
```

Nothing about the message is interpreted on the server. The whole thing is stored as it arrived
and read in the browser by the same parser an upload goes through, so the supplier match, the
project rules, the duplicate check and the "not collected" scope all behave identically whether
the invoice was emailed or dropped in by hand.

---

## The one thing that must not be got wrong

`sydneylvl.com` is a **Google Workspace** domain — its MX is `smtp.google.com`, and its DNS is
**Google Cloud DNS** (`ns-cloud-b*.googledomains.com`).

If that domain itself is pointed at another mail provider, **every** address on it routes there,
`ivan@sydneylvl.com` included, and your own mail stops arriving. So the receiving domain is a
subdomain — `inbox.sydneylvl.com` — and the MX record below goes on the subdomain only. Your
Google Workspace mail is untouched.

Suppliers can still be given the tidy address. Create `invoices@sydneylvl.com` in Google Workspace
(Admin console → Directory → Groups, or as an alias with forwarding) and forward it to
`invoices@inbox.sydneylvl.com`. Mail then arrives in both places: your Workspace copy, and the
system.

---

## Doing it

### 1. One script

```powershell
powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\setup.ps1
```

It signs you in to Supabase in a browser, invents the shared key, stores it as a secret, deploys
the function and prints the webhook URL. The key is never written to a file and never committed —
copy the URL it prints, because it is not saved anywhere.

Nothing in it needs your database password.

### 2. The table

Supabase dashboard → SQL Editor → paste `supabase/migrations/20260909_ap_inbox.sql` → **Run**.

### 3. Resend

You already use Resend for outgoing mail, and its key is already a secret on this project, so the
function can fetch messages without anything further.

1. **Domains → Add domain →** `inbox.sydneylvl.com`.
2. Resend gives you an **MX record**. Add it in the Google Cloud console → Cloud DNS → the
   `sydneylvl.com` zone → Add record set, with DNS name `inbox`. Nothing else in the zone changes.
3. **Emails → Receiving → create a webhook**, pasting the URL the script printed.

Resend's webhook only announces that mail has arrived; the function then fetches the whole message
from Resend and stores that, so nothing is lost to a summary.

### 4. Tell the app

Settings → **Invoice ingestion** → put `invoices@sydneylvl.com` in **Receiving address**, then
press **Check now**. The pill turns green the first time it reaches the table.

Setting the address does one more thing: its domain becomes an *internal* domain, so a message
forwarded by one of your own people is read as a forward, and the supplier is taken from the
invoice inside rather than from whoever passed it on.

---

## Checking it works, without waiting for a supplier

```bash
curl -X POST "<the URL the script printed>" \
  -H "Content-Type: message/rfc822" \
  --data-binary @some-invoice-email.eml
```

`{"ok":true,"stored":true}` means it is in the table. Press **Check now** in the app and the
invoice appears. Send the same file twice and the second is refused as a duplicate — which is what
should happen when a provider retries.

## When something does not arrive

| What you see | What it means |
|---|---|
| `401 Not authorised` | The `key` in the URL is not the one the script set. Run the script again and re-paste the new URL into Resend. |
| `{"ok":true,"ignored":"not a receiving address"}` | It was sent to an address outside `INBOUND_TO`. |
| Stored, but the app shows nothing | Press **Check now**. If the pill stays amber, step 2 has not been done. |
| It arrives under **Not collected** | It was read fine; the rules could not place it on a project. The **Not collected** tab lists it, and **Collect** takes it back. Giving the project a short code makes this much rarer. |
| Nothing at all, anywhere | The mail never reached Resend. Check the MX record on `inbox.` and the forwarding rule — not this function. |

## Other providers

The function's contract is "give me the whole message". As well as Resend's `email.received`
webhook, it takes raw MIME as a `message/rfc822` body, as a `multipart/form-data` field named
`email`, `body-mime`, `message` or `raw`, or as a JSON field of the same names — which covers
SendGrid Inbound Parse, Mailgun's raw-MIME store, Postmark's `RawEmail`, and the Cloudflare Email
Worker in `worker.example.js`. If a provider only sends parsed pieces, they are reassembled into a
message so the app still sees one shape.

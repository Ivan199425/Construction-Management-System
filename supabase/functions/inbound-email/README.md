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

## Two routes, and why you would pick one

|  | **Forward** | **Own address** |
|---|---|---|
| Address suppliers use | the one they already use | `invoices@sydneylvl.com` |
| DNS | **none** | one MX record on a subdomain |
| How mail gets in | Workspace forwards a copy to a Resend-managed address | delivered straight to Resend |
| Set up in | Resend + Gmail | Resend + Google Cloud DNS |

**Forward** is the one to start with. It needs no DNS at all, nothing about your existing mail
changes, and it can be undone by deleting one filter. The other route is worth moving to later if
you want a `invoices@` address of your own that suppliers write to directly.

---

## Common to both

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

### 3. Prove it before involving mail

```powershell
powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\send-test.ps1
```

Sends a real invoice email straight at the function, as a provider would. If an invoice appears in
the app after **Check mail**, everything except mail delivery is working, and any later silence has
one cause instead of five.

---

## Route A — forward, no DNS

### 1. Get a receiving address

Resend → **Emails → Receiving → the three dots → Receiving address**. It gives you something like
`abc123.resend.app`, working immediately, with no records to add anywhere.

### 2. Let the function accept it

```powershell
powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\set-receiving.ps1
```

That writes `INBOUND_TO` only — the key, and so the webhook URL you already have, is untouched.

### 3. Point Resend at the function

Resend → **Emails → Receiving → create a webhook**, pasting the URL from `setup.ps1`.

Resend's webhook only announces that mail has arrived; the function then fetches the whole message
from Resend and stores that, so nothing is lost to a summary.

### 4. Forward the invoices to it

To `invoices@<id>.resend.app`. Either:

- **Admin console → Apps → Google Workspace → Gmail → Routing**, adding a rule that sends a copy
  there. An administrator can do this without the far end confirming, which is tidier; or
- **Gmail → Settings → Forwarding**, which sends a confirmation code to the address first. That
  code arrives in `ap_inbox` like anything else — read it in the Supabase Table Editor, in the
  `raw` column of the newest row, and paste it back into Gmail.

Forward selectively rather than everything: a filter on `has:attachment` plus a sender or subject
condition keeps the queue to invoices. The collect scope and the attachment rule are a second line
of defence, not the first.

### 5. Tell the app

Settings → **Invoice ingestion** → Receiving address → **`ivan@sydneylvl.com`**. That is the
address suppliers actually write to, and it is what makes `sydneylvl.com` an internal domain, so a
forward is read as a forward and the supplier is taken from the invoice inside rather than from
whoever passed it on. The `resend.app` address is plumbing and does not belong in that field.

---

## Route B — an address of your own

`sydneylvl.com` is a **Google Workspace** domain: its MX is `smtp.google.com`, and its DNS is
**Google Cloud DNS** (the SOA names `cloud-dns-hostmaster.google.com`).

> **The one thing that must not be got wrong.** If that domain itself is pointed at another mail
> provider, **every** address on it routes there, `ivan@sydneylvl.com` included, and your own mail
> stops arriving. The receiving domain is a subdomain — `inbox.sydneylvl.com` — and the MX record
> goes on the subdomain only.

1. Resend → **Domains → Add domain →** `inbox.sydneylvl.com`. Copy the MX record it gives you.
2. Google Cloud console → **Network Services → Cloud DNS** → the `sydneylvl.com` zone →
   **Add standard**:

   | Field | Value |
   |---|---|
   | DNS name | `inbox` — just that word; the console appends the rest |
   | Type | `MX` |
   | TTL | 5 minutes |
   | Priority | `10` |
   | Mail server | what Resend gave you, **with a trailing dot** |

   Do not edit the existing MX record set on the root. You are adding a new one.
3. Resend → **Emails → Receiving → create a webhook** with the URL from `setup.ps1`.
4. Give suppliers `invoices@sydneylvl.com` by creating it in Workspace and forwarding it to
   `invoices@inbox.sydneylvl.com` — so a copy stays in Gmail as well.
5. Settings → **Invoice ingestion** → Receiving address → `invoices@sydneylvl.com`.

---

## When something does not arrive

| What you see | What it means |
|---|---|
| `401 Not authorised` | The `key` in the URL is not the one the script set. Run `setup.ps1` again and re-paste the new URL into Resend. |
| `{"ok":true,"ignored":"not a receiving address"}` | It was sent to an address outside `INBOUND_TO`. Run `set-receiving.ps1`. |
| Stored, but the app shows nothing | Press **Check mail**. If the pill stays amber, the migration has not been run. |
| It arrives under **Not collected** | It was read fine; the rules could not place it on a project. The **Not collected** tab lists it and **Collect** takes it back. Giving the project a short code makes this much rarer. |
| Nothing at all, anywhere | The mail never reached Resend — check the forwarding rule, or the MX record on `inbox.`. Not this function. |

## Other providers

The function's contract is "give me the whole message". As well as Resend's `email.received`
webhook, it takes raw MIME as a `message/rfc822` body, as a `multipart/form-data` field named
`email`, `body-mime`, `message` or `raw`, or as a JSON field of the same names — which covers
SendGrid Inbound Parse, Mailgun's raw-MIME store, Postmark's `RawEmail`, and the Cloudflare Email
Worker in `worker.example.js`. If a provider only sends parsed pieces, they are reassembled into a
message so the app still sees one shape.

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

|  | **Read your own mailbox** | **An address of your own** |
|---|---|---|
| Address suppliers use | the one they already use | `invoices@sydneylvl.com` |
| DNS | **none** | one MX record on a subdomain |
| Needs a mail provider | **no** | yes, with inbound support |
| How mail gets in | a script in your Google account posts each message | delivered straight to the provider |
| Set up in | script.google.com, once | provider + Google Cloud DNS |

**Read your own mailbox** is the one to start with, and for most people it is the only one worth
doing. It needs no DNS, no MX record, no second mail provider and no OAuth application: it runs
inside the Google account that already receives the invoices, with the permission that account
already has. Nothing about your existing mail changes, and deleting the script undoes it.

> Inbound email is not on every provider's plan — Resend's receiving feature in particular may
> simply not appear in your dashboard. That rules out the second route entirely and does not
> affect the first one at all, which is the main reason it is the recommendation.

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

## Route A — read your own mailbox

`gmail-forwarder.gs` in this folder is a Google Apps Script. It runs in the account the invoices
already arrive at, finds the ones matching a query, and posts each whole message to the function.

### 1. Paste it in

Signed in as that account, open **script.google.com → New project**, delete the sample, paste in
`gmail-forwarder.gs`.

### 2. Give it the URL

Set `ENDPOINT` at the top to the webhook URL `setup.ps1` printed, `?key=...` included. Lost it?
Run `setup.ps1` again — it mints a new key and prints a new URL.

### 3. Check it

**Run → testConnection.** Google asks you to authorise it; it is your own script reading your own
mailbox, so approve it. The "unverified app" screen is expected for a script you wrote yourself —
*Advanced → Go to project*. A `200` in the log means the whole chain works. Open CPMS → Invoices →
**Check mail** and the test invoice appears.

### 4. Set it running

**Run → collectInvoices** once by hand to see what it picks up, then **Triggers (clock icon) → Add
trigger → collectInvoices → Time-driven → Minutes timer → Every 15 minutes.**

### 5. Narrow the query

`QUERY` starts at `has:attachment newer_than:7d -from:me`. Everything it matches goes in front of
whoever clears the invoice queue, so tighten it once it runs — `subject:(invoice OR "tax invoice"
OR claim)`, or `to:accounts@sydneylvl.com`. The collect scope and the attachment rule in CPMS are a
second line of defence, not a substitute for a sensible query.

### 6. Tell the app

Settings → **Invoice ingestion** → Receiving address → **`accounts@sydneylvl.com`**. That is what
makes `sydneylvl.com` an internal domain, so a message forwarded by one of your own people is read
as a forward and the supplier is taken from the invoice inside rather than from whoever passed it
on.

Nothing needs changing on the server for this route: the script sends the address the mail was
delivered to, which is already on the accept list.

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

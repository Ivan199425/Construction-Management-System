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

It asks for the webhook URL. Once `make-gmail-script.ps1` (Route A) has run, the URL `setup.ps1`
printed is retired: use the `ENDPOINT` value from `CPMS-gmail-collector.gs` on your Desktop.

---

## Route A — read your own mailbox

`gmail-forwarder.gs` in this folder is a Google Apps Script. It runs in a mailbox the invoices
arrive at, finds the ones that are invoices, and posts each whole message to the function.

### 0. Invoices arrive at several addresses

A script can only read the mailbox it runs in. When suppliers write to `ivan@`, `sales@`,
`accounts@`, `sam@` and so on, have one mailbox collect for everybody:

**Google Admin console → Menu → Apps → Google Workspace → Gmail → Routing → Email forwarding using
recipient address map → Configure** (or **Add another rule**). Add one line per address —
*Address* `ivan@sydneylvl.com`, *Map to address* `accounts@sydneylvl.com` — for every address
except `accounts@` itself. **Messages to affect: Only external incoming messages.** Tick **Also
route to original destination**, or those people stop receiving their own mail. **Save.** Google
says a change can take up to 24 hours to apply; it is usually minutes.

Everybody keeps their mail, and `accounts@` receives a copy of what outside senders write to them.
Install the script once, in `accounts@`. CPMS still records which address the supplier wrote to.

(Without admin access: install the same file in each mailbox instead. Run
`make-gmail-script.ps1` once and paste that one file everywhere — running it again makes a new key
and stops the copies already pasted.)

### 1. Make the script

```powershell
powershell -ExecutionPolicy Bypass -File supabase\functions\inbound-email\make-gmail-script.ps1
```

It makes a new key, stores it on the server, deploys the inbound-email function from this folder,
and writes `CPMS-gmail-collector.gs` to your Desktop with the URL already in `ENDPOINT`. That file
has the key in it — never put it in this repository, and never fill in `ENDPOINT` in
`gmail-forwarder.gs` here: the repository is public, and the script needs that line as it is.

### 2. Paste it in

Signed in as the collecting mailbox, open **script.google.com → New project**, delete the sample,
paste in the Desktop file, **Ctrl+S**.

### 3. Check it

Pick **testConnection → Run.** Google asks you to authorise it; it is your own script reading your
own mailbox, so approve it. The "unverified app" screen is expected for a script you wrote yourself —
*Advanced → Go to project*. A `200` in the log means the whole chain works. Open CPMS → Supplier
Invoices → **Check mail**. The test message has nothing attached, so with *Only consider mail
carrying a PDF or image attachment* ticked (the default) it shows under **Not collected** with the
reason "No invoice was attached" — that is a pass.

### 4. Set it running

Pick **collectInvoices → Run** once to see what it picks up, then **turnOn → Run.** It now runs every
15 minutes by itself; **turnOff** stops it.

### 5. What it collects

`SEARCH` takes mail with an attachment that says *invoice*, *inv*, *claim* or *amount / balance /
payment due* — in the subject, the email, or printed in the PDF itself, because Gmail searches
inside PDFs. `DAYS` (30) is how far back it looks. It sends PDFs and pictures — attached, or pasted
into the email the way a phone's mail app does — but not a logo in a signature, and never mail sent
from the collecting mailbox itself. In a conversation it sends only the messages that match on
their own, so the quote that came before an invoice stays out. (A reply that keeps "invoice" or
"claim" in its subject still matches, attachments and all.)

A scanned invoice has no printed words for Gmail to find. To send every email with a PDF or
picture, whatever it is, set `var SEARCH = 'has:attachment -from:me';` — CPMS then puts anything it
cannot place on a project under Unallocated or Not collected, depending on the collect setting.
After changing `SEARCH`, run **resetHistory** once so mail already passed over is looked at again.

Nothing is sent twice: the script remembers what it has sent, and the database refuses a second
copy of the same message anyway. Mail CPMS itself sends — a bill sent on to accounts, a claim sent
for payment — comes from the no-reply sending address and is turned away by the function, so it does
not come back in as a new invoice. (If somebody forwards one of those on, the forward is taken in like
any other mail.)

### 6. Tell the app

Settings → **Invoice ingestion**:

- **Provider** → Google Workspace.
- **Receiving address** → **`accounts@sydneylvl.com`**. That is what makes `sydneylvl.com` an
  internal domain, so a message forwarded by one of your own people is read as a forward and the
  supplier is taken from the invoice inside rather than from whoever passed it on.
- **What to collect** → **Everything that arrives** if every invoice should reach Supplier
  Invoices, with those it cannot place on a project waiting under **Unallocated**. *Only invoices for
  a project in this system* sets those aside under **Not collected** instead.
- *Only consider mail carrying a PDF or image attachment* — leave it ticked. Mail from the script
  always carries one; it is what keeps covering notes out.

The script sends the address the mail was written to, which `sydneylvl.com` in `INBOUND_TO`
already accepts, so nothing else changes on the server.

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
| `401 Not authorised` (Gmail script) | The script has an old key. Paste the current `CPMS-gmail-collector.gs` from your Desktop into every mailbox that runs it. If that file is gone, run `make-gmail-script.ps1` once and paste the new file into all of them. Do **not** run `setup.ps1` for this — it makes another key. |
| `401 Not authorised` (Resend) | The `key` in the webhook URL is not the one on the server. Run `setup.ps1` again and paste the new URL into Resend. |
| `{"ok":true,"ignored":"not a receiving address"}` | It was sent to an address outside `INBOUND_TO`. Run `set-receiving.ps1`. |
| Stored, but the app shows nothing | Press **Check mail**. If the pill stays amber, the migration has not been run. |
| It arrives under **Not collected** | The reason is on it. "No invoice was attached": nothing readable was attached and the attachment box in Settings is ticked. Otherwise the rules could not place it on a project and **What to collect** is set to projects in this system only — set it to **Everything that arrives** to have those wait under **Unallocated** instead. **Collect** takes any of them back. The rules place an invoice by a PO or subcontract number; the project number as a reference of its own ("WHJ-24", "WALLSE" — or "Job 001" / "PO 001" when it is only digits); the project name; or the site's street number, street name and a street type ("8 Hilma St" for 8 Hilma Avenue). |
| An email never reaches CPMS | Search for it in Gmail in the collecting mailbox with `in:anywhere` — an invoice in **Spam** is never searched; mark it *Not spam*. If it is there, find the run that first looked at it in Apps Script → **Executions** and read its log: it says when a message is passed over (no PDF or picture, or not an invoice by `SEARCH`); a later run only counts it as looked at before. Or run **resetHistory** then **collectInvoices** to see it again — copies CPMS already has are answered as duplicates. Mail older than `DAYS` is never looked at. The **CPMS collected** label is per conversation, so a labelled conversation can still hold a message that was not sent. After changing `SEARCH`, run **resetHistory** so passed-over mail is looked at again. No **CPMS collected** label anywhere means the script has never run: step 4. |
| Nothing at all, anywhere | The mail never reached Resend — check the forwarding rule, or the MX record on `inbox.`. Not this function. |

## Other providers

The function's contract is "give me the whole message". As well as Resend's `email.received`
webhook, it takes raw MIME as a `message/rfc822` body, as a `multipart/form-data` field named
`email`, `body-mime`, `message` or `raw`, or as a JSON field of the same names — which covers
SendGrid Inbound Parse, Mailgun's raw-MIME store, Postmark's `RawEmail`, and the Cloudflare Email
Worker in `worker.example.js`. If a provider only sends parsed pieces, they are reassembled into a
message so the app still sees one shape.

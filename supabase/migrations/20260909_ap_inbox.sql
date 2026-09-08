-- ap_inbox: where an emailed invoice waits before the app collects it
--
-- Why this exists
-- ---------------
-- Until now an invoice could only get into this system by somebody dropping a file on the
-- Invoices screen. The Settings panel asked for a mailbox and a polling interval, but nothing
-- read them: no part of the app has ever opened a mailbox.
--
-- This table is the missing middle. A message sent to the receiving address is handed to the
-- inbound-email function, which writes it here whole and unparsed. The app then picks it up and
-- runs it through exactly the same reader an uploaded .eml goes through, so a collected email
-- and a dropped file behave identically from that point on.
--
-- The raw message is kept, not a summary of it. Everything downstream — the supplier match, the
-- project rules, the duplicate check — reads the message itself, and a parser improved next year
-- can be run over the same text again.
--
-- Who may do what
-- ---------------
-- Only the function writes, and it writes with the service role, which bypasses RLS. Nobody
-- signed in to the app can insert, so a browser cannot push anything into the queue. Signed-in
-- users may read a message and mark it collected; that is all the app needs.
--
-- Safe to run more than once.
--
--   Supabase dashboard -> SQL Editor -> paste -> Run
--
-- ---------------------------------------------------------------------------

create table if not exists public.ap_inbox (
  id            uuid primary key default gen_random_uuid(),
  received_at   timestamptz not null default now(),
  to_addr       text        not null default '',
  from_addr     text        not null default '',
  subject       text        not null default '',
  message_id    text        not null default '',
  size_bytes    integer     not null default 0,
  -- The whole message, exactly as it arrived, headers and base64 attachments included.
  raw           text        not null default '',
  -- new -> collecting -> collected, or failed. 'collecting' is a claim, not a state anybody
  -- waits in: it is how two open windows avoid reading the same message twice.
  status        text        not null default 'new',
  attempts      integer     not null default 0,
  note          text        not null default '',
  invoice_ids   text[]      not null default '{}',
  collected_at  timestamptz,
  collected_by  text        not null default ''
);

create index if not exists ap_inbox_status_idx on public.ap_inbox (status, received_at);

-- A provider that does not hear a prompt 200 will send the same message again. Where the message
-- carries an id, that retry is refused by the database rather than by anybody noticing later.
create unique index if not exists ap_inbox_msgid_idx
  on public.ap_inbox (message_id) where message_id <> '';

alter table public.ap_inbox enable row level security;

drop policy if exists ap_inbox_read on public.ap_inbox;
create policy ap_inbox_read on public.ap_inbox
  for select to authenticated using (true);

drop policy if exists ap_inbox_claim on public.ap_inbox;
create policy ap_inbox_claim on public.ap_inbox
  for update to authenticated using (true) with check (true);

grant select, update on public.ap_inbox to authenticated;

-- A collected message has done its job. The raw text is the bulky part and the invoice it became
-- holds its own copy of the attachment, so it is cleared after a fortnight — long enough to look
-- into anything that went in wrongly, short enough that the table does not grow without end.
-- Nothing is deleted: the row, and what it turned into, stay.
create or replace function public.ap_inbox_prune()
returns integer
language sql
as $$
  with done as (
    update public.ap_inbox
       set raw = ''
     where status = 'collected'
       and raw <> ''
       and collected_at < now() - interval '14 days'
    returning 1
  )
  select count(*)::integer from done;
$$;

-- Check it took:
--   select status, count(*) from public.ap_inbox group by status;

-- Per-user interface preferences (column widths, column order, hidden columns).
-- One row per user, readable and writable only by that user, so a layout follows the person
-- from machine to machine and survives a browser's storage being cleared.
--
-- Run once in the Supabase SQL editor. Safe to run again.

create table if not exists public.user_prefs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_prefs enable row level security;

-- Each user sees and writes their own row, and nobody else's.
drop policy if exists user_prefs_select_own on public.user_prefs;
create policy user_prefs_select_own on public.user_prefs
  for select using (auth.uid() = user_id);

drop policy if exists user_prefs_insert_own on public.user_prefs;
create policy user_prefs_insert_own on public.user_prefs
  for insert with check (auth.uid() = user_id);

drop policy if exists user_prefs_update_own on public.user_prefs;
create policy user_prefs_update_own on public.user_prefs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.user_prefs to authenticated;

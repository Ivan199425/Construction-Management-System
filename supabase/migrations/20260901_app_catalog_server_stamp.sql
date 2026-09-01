-- app_catalog: let the database own updated_at
--
-- Why this exists
-- ---------------
-- Every shared document in this app lives in one app_catalog row, and a save is a conditional
-- update: "write this row only if updated_at is still the value I read". That is what stops a
-- second window overwriting the first.
--
-- The guard is only as trustworthy as the value it compares. Today that value is minted by the
-- browser doing the writing, from that machine's clock. The app already forces it forward — it
-- writes max(now, the value already there + 1ms) — so a wrong clock cannot make the stamp go
-- backwards. But a stamp the racing clients mint themselves is still a wall clock pretending to
-- be a version.
--
-- Running this hands the job to Postgres. The trigger stamps every insert and update with the
-- server's own clock, so all writers are measured against one clock instead of their own. The
-- app reads the stored value back (Prefer: return=representation) and uses whatever the database
-- put there, so it works correctly either way — this migration is an improvement, not a
-- prerequisite, and nothing breaks if it is never run.
--
-- Safe to run more than once. Takes a brief lock on a nine-row table; run it any time.
--
--   Supabase dashboard → SQL Editor → paste → Run
--
-- ---------------------------------------------------------------------------

alter table public.app_catalog
  alter column updated_at set default now();

create or replace function public.app_catalog_touch()
returns trigger
language plpgsql
as $$
begin
  -- clock_timestamp(), not now(): now() is the transaction start time, so two writes inside one
  -- transaction would be stamped identically and the second could not be told from the first.
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists app_catalog_touch on public.app_catalog;

create trigger app_catalog_touch
  before insert or update on public.app_catalog
  for each row execute function public.app_catalog_touch();

-- Check it took: run this, save something in the app, run it again. The stamp must move.
--   select key, updated_at from public.app_catalog order by key;

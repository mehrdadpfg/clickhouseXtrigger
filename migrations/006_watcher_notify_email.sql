-- 006_watcher_notify_email — where a tripped watcher's alert is emailed.
--
-- Tripping used to be a screen-only event: a row in `alerts`, a red card on the
-- Watch page, and a browser notification that only lands if the tab happens to
-- be open and permitted. This adds the reliable path — email via Resend — with
-- two places to say WHERE:
--
--   * watchers.notify_email — a recipient for THIS watcher, set in its editor.
--     Null (the common case) means "use the global default".
--   * app_settings.default_notify_email — the fallback, one per install, set on
--     the Settings page. Null means email notifications are simply off until an
--     address is given somewhere.
--
-- The tick resolves notify_email ?? default at fire time, so changing the
-- default reroutes every watcher that never set its own — no backfill needed.
--
-- Idempotent: safe to re-run.

alter table watchers
  add column if not exists notify_email text;

-- ---------------------------------------------------------------------------
-- app_settings — global, install-wide preferences. Singleton by construction.
-- ---------------------------------------------------------------------------
-- One row, forever: the boolean primary key defaults to true and is CHECKed to
-- be true, so a second insert collides on the primary key rather than creating
-- a second "global default". Reads and writes target id = true.
create table if not exists app_settings (
  id                   boolean     primary key default true check (id),
  -- The fallback recipient for any watcher without its own notify_email. Null
  -- until an address is saved on the Settings page — notifications stay off.
  default_notify_email text,
  updated_at           timestamptz not null default now()
);

-- Seed the single row so an UPDATE on the Settings page always has a row to hit.
insert into app_settings (id) values (true) on conflict (id) do nothing;

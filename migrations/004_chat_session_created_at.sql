-- When a chat's Trigger Session was OPENED, as distinct from when it was last
-- used.
--
-- A Session pins to the worker version it started on, so tools added after it
-- opened are invisible to it — but updated_at is bumped on every turn, so a
-- stale session keeps refreshing its own timestamp and looks current. Only the
-- creation time can say which worker build a session belongs to.
--
-- Backfilled from updated_at: for rows that already exist the two are the best
-- estimate available, and being conservative here only means an old session
-- survives one extra load.
alter table chat_sessions
  add column if not exists created_at timestamptz not null default now();

update chat_sessions set created_at = updated_at where created_at > updated_at;

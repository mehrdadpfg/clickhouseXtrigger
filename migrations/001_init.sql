-- 001_init — app state: chats, watchers, alerts, boards.
--
-- Postgres holds small, frequent, mutating writes. It does NOT hold:
--   * chat messages      — those live in Trigger.dev sessions; we keep only the
--                          sidebar list (title + ordering) here.
--   * query history      — that comes from ClickHouse system.query_log, which
--                          already records every query's text, duration and rows.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- chats — the history sidebar. Messages live in Trigger sessions.
-- ---------------------------------------------------------------------------
create table if not exists chats (
  id              uuid primary key default gen_random_uuid(),
  title           text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Null until the first message lands. Drives sidebar ordering.
  last_message_at timestamptz
);

-- Sidebar reads "most recent conversation first". A chat with no messages yet
-- sorts by created_at, hence the coalesce — the index must match the ORDER BY
-- expression exactly or it won't be used.
create index if not exists chats_recent_idx
  on chats (coalesce(last_message_at, created_at) desc);

-- ---------------------------------------------------------------------------
-- watchers — standing questions, re-run in the background by trigger.dev.
-- ---------------------------------------------------------------------------
create table if not exists watchers (
  id          uuid primary key default gen_random_uuid(),
  -- The thread a watcher was born in, for the "Open thread →" jump.
  -- Watchers outlive their chat: deleting a chat orphans the watcher rather
  -- than destroying a standing query the user still depends on.
  chat_id     uuid references chats (id) on delete set null,
  question    text        not null,
  sql         text        not null,
  -- Cadence as authored ('5m', '1h', '6h', 'daily'). The trigger task maps this
  -- to a schedule; storing the intent rather than a cron keeps the UI honest.
  schedule    text        not null,
  -- { direction: rises_above | drops_below | changes_by, value, unit?, baseline? }
  threshold   jsonb       not null default '{}'::jsonb,
  state       text        not null default 'active'
                check (state in ('active', 'paused', 'error')),
  last_run_at timestamptz,
  -- Null until the first run. FIRING in the UI is (state='active' and is_firing).
  last_value  numeric,
  is_firing   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The firing hero card asks for "the few that are firing" out of all watchers.
-- Partial: only firing rows are indexed, so it stays tiny.
create index if not exists watchers_firing_idx
  on watchers (updated_at desc) where is_firing;

-- The scheduled task sweeps active watchers every tick.
create index if not exists watchers_state_idx on watchers (state);

create index if not exists watchers_chat_id_idx
  on watchers (chat_id) where chat_id is not null;

-- ---------------------------------------------------------------------------
-- alerts — a watcher tripped. Immutable log; only `acknowledged` ever changes.
-- ---------------------------------------------------------------------------
create table if not exists alerts (
  id           uuid primary key default gen_random_uuid(),
  watcher_id   uuid        not null references watchers (id) on delete cascade,
  fired_at     timestamptz not null default now(),
  value        numeric,
  message      text        not null,
  acknowledged boolean     not null default false
);

-- Serves both "recent alerts for this watcher" and the cascade delete.
create index if not exists alerts_watcher_id_idx
  on alerts (watcher_id, fired_at desc);

-- Global "recent alerts" feed.
create index if not exists alerts_fired_at_idx on alerts (fired_at desc);

-- Unread badge count. Partial: acknowledged alerts are the vast majority.
create index if not exists alerts_unacknowledged_idx
  on alerts (fired_at desc) where not acknowledged;

-- ---------------------------------------------------------------------------
-- boards / board_tiles — pinned results.
-- ---------------------------------------------------------------------------
create table if not exists boards (
  id         uuid primary key default gen_random_uuid(),
  title      text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists boards_recent_idx on boards (updated_at desc);

create table if not exists board_tiles (
  id       uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards (id) on delete cascade,
  kind     text not null check (kind in ('kpi', 'chart', 'table')),
  title    text not null,
  sql      text not null,
  -- Render config: axes, series, format. Shape depends on `kind`.
  spec     jsonb not null default '{}'::jsonb,
  -- Dense ordering within a board, 0-based.
  position int  not null default 0
);

-- Every tile read is "this board's tiles, in order".
create index if not exists board_tiles_board_id_idx
  on board_tiles (board_id, position);

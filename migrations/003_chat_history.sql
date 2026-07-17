-- 003_chat_history — persist chat messages + per-chat transport state.
--
-- The Trigger.dev Session is the live source of truth while a run is alive, but
-- a reloaded tab needs two things back before any run exists:
--
--   1. the conversation so far, to hand to useChat as `initialMessages`, and
--   2. the transport's session state (public access token + last event id), so
--      the transport resubscribes to the SAME session instead of minting a new
--      one and losing the thread.
--
-- These tables hold exactly that. Messages are stored one UIMessage per row
-- (chat_id, message_id) so a turn can upsert its rows without rewriting the
-- whole conversation; the session is one row per chat.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout, safe to re-run.

create table if not exists chat_messages (
  chat_id    uuid        not null,
  message_id text        not null,
  role       text        not null,
  -- The full UIMessage as sent to the frontend, replayed verbatim on load.
  message    jsonb       not null,
  -- 0-indexed turn the message belongs to, from onTurnComplete.
  turn       integer     not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);

-- Load order: by turn, then arrival. The role tiebreak (user before assistant)
-- keeps a turn's own two rows ordered when their created_at collide.
create index if not exists chat_messages_chat_order_idx
  on chat_messages (chat_id, turn, created_at);

create table if not exists chat_sessions (
  chat_id             uuid        primary key,
  -- Session-scoped JWT the transport refreshes on 401/403.
  public_access_token text        not null,
  -- Last SSE event seen on .out; lets a reconnect skip already-seen chunks.
  last_event_id       text,
  updated_at          timestamptz not null default now()
);

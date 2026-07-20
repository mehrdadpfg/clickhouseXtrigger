/**
 * Row types for the Postgres app-state tables. These mirror migrations/*.sql.
 *
 * Declared as `type` aliases rather than `interface` on purpose: the db query
 * helper is `query<T extends Record<string, unknown>>`, and an interface has no
 * implicit index signature, so it fails that constraint. Type aliases satisfy it.
 *
 * timestamptz arrives as a JS Date; numeric/bigint arrive as numbers (see the
 * type parsers in lib/db/client.ts).
 */

// --- chats -----------------------------------------------------------------

/** A conversation in the history sidebar. Messages live in Trigger sessions. */
export type ChatRow = {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  /** Null until the first message lands. */
  last_message_at: Date | null;
};

/**
 * One persisted chat message (a UIMessage) — the reloadable conversation.
 * `message` is the full UIMessage jsonb; the repo returns it typed as UIMessage.
 */
export type ChatMessageRow = {
  chat_id: string;
  message_id: string;
  role: string;
  message: Record<string, unknown>;
  turn: number;
  created_at: Date;
};

/** Per-chat transport state a reloaded tab restores. */
export type ChatSessionRow = {
  chat_id: string;
  public_access_token: string;
  last_event_id: string | null;
  updated_at: Date;
};

// --- watchers --------------------------------------------------------------

/** How a watcher's reading is compared against its threshold. */
export type WatcherDirection = "rises_above" | "drops_below" | "changes_by";

/**
 * `active` and `paused` are user intent; `error` means the SQL stopped running.
 * FIRING is not a state — it's (state === 'active' && is_firing).
 */
export type WatcherState = "active" | "paused" | "error";

/** Contents of watchers.threshold (jsonb). Written only through lib/db/watchers. */
export type WatcherThreshold = {
  direction: WatcherDirection;
  value: number;
  /** Display unit carried from the source chart ('$', '%', '×'). */
  unit?: string;
  /** Only meaningful for `changes_by` — what the change is measured against. */
  baseline?: "four_week_average";
};

/** A standing question, re-run in the background. */
export type WatcherRow = {
  id: string;
  /** The thread it was born in. Null once that chat is deleted — watchers outlive chats. */
  chat_id: string | null;
  question: string;
  sql: string;
  /**
   * Cadence as authored: '5m' | '1h' | '6h' | 'daily'. Typed `string` rather
   * than a union because the column is `text` — a hand-edited row can hold
   * anything, and the task has to survive reading it.
   */
  schedule: string;
  threshold: WatcherThreshold;
  state: WatcherState;
  /**
   * The Trigger.dev schedule driving this watcher (imperative, one per
   * watcher). Null until it is attached, or if attaching failed — a watcher
   * with no schedule is inert, not broken.
   */
  schedule_id: string | null;
  last_run_at: Date | null;
  /** Null until the first run. */
  last_value: number | null;
  is_firing: boolean;
  created_at: Date;
  updated_at: Date;
  /** Why the last tick failed, or null once it reads cleanly again. */
  last_error: string | null;
};

// --- alerts ----------------------------------------------------------------

/** A watcher tripped. Immutable except for `acknowledged`. */
export type AlertRow = {
  id: string;
  watcher_id: string;
  fired_at: Date;
  value: number | null;
  message: string;
  acknowledged: boolean;
};

// --- boards ----------------------------------------------------------------

export type BoardRow = {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
};

/** A board plus its tile count, for the board picker / list. */
export type BoardWithTileCountRow = BoardRow & { tile_count: number };

export type BoardTileKind = "kpi" | "chart" | "table";

/**
 * Render config for a tile (axes, series, formatting). The shape depends on
 * `kind` and is owned by the chart layer, so it stays open here.
 */
export type BoardTileSpec = Record<string, unknown>;

export type BoardTileRow = {
  id: string;
  board_id: string;
  kind: BoardTileKind;
  title: string;
  sql: string;
  spec: BoardTileSpec;
  /** Dense, 0-based ordering within the board. */
  position: number;
};

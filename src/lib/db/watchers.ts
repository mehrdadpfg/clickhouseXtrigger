/**
 * Watchers — standing questions re-run in the background by trigger.dev.
 *
 * The `sql` column holds a query authored against whatever table the user is
 * exploring; it is stored and replayed as opaque text. Nothing here knows or
 * cares which table that is.
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";
import type { WatcherRow, WatcherState, WatcherThreshold } from "@/types/db";

const COLUMN_NAMES = [
  "id",
  "chat_id",
  "question",
  "sql",
  "schedule",
  "threshold",
  "state",
  "schedule_id",
  "last_run_at",
  "last_value",
  "is_firing",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof WatcherRow)[];

const COLUMNS = COLUMN_NAMES.join(", ");

/** Same list, qualified — needed where a statement joins the table to itself. */
function columnsOf(alias: string): string {
  return COLUMN_NAMES.map((c) => `${alias}.${c}`).join(", ");
}

export async function listWatchers(): Promise<WatcherRow[]> {
  // Firing first, then most recently run — the order the Watch page renders.
  return query<WatcherRow>(
    `select ${COLUMNS} from watchers
     order by (state = 'active' and is_firing) desc,
              last_run_at desc nulls last,
              created_at desc`,
  );
}

/** Powers the firing hero card. Paused watchers never count as firing. */
export async function listFiringWatchers(): Promise<WatcherRow[]> {
  return query<WatcherRow>(
    `select ${COLUMNS} from watchers
     where is_firing and state = 'active'
     order by updated_at desc`,
  );
}

/** The set the scheduled task sweeps each tick. */
export async function listActiveWatchers(): Promise<WatcherRow[]> {
  return query<WatcherRow>(
    `select ${COLUMNS} from watchers where state = 'active' order by created_at`,
  );
}

export async function listWatchersForChat(chatId: string): Promise<WatcherRow[]> {
  return query<WatcherRow>(
    `select ${COLUMNS} from watchers where chat_id = $1 order by created_at desc`,
    [chatId],
  );
}

export async function getWatcher(id: string): Promise<WatcherRow | null> {
  const rows = await query<WatcherRow>(
    `select ${COLUMNS} from watchers where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createWatcher(input: {
  question: string;
  sql: string;
  schedule: string;
  threshold: WatcherThreshold;
  chatId?: string | null;
  state?: WatcherState;
}): Promise<WatcherRow> {
  const rows = await query<WatcherRow>(
    `insert into watchers (chat_id, question, sql, schedule, threshold, state)
     values ($1, $2, $3, $4, $5::jsonb, coalesce($6, 'active'))
     returning ${COLUMNS}`,
    [
      input.chatId ?? null,
      input.question,
      input.sql,
      input.schedule,
      JSON.stringify(input.threshold),
      input.state ?? null,
    ],
  );
  return rows[0]!;
}

/** Fields a caller may patch. Anything run-related goes through recordWatcherRun. */
export type WatcherPatch = {
  question?: string;
  sql?: string;
  schedule?: string;
  threshold?: WatcherThreshold;
  state?: WatcherState;
};

// Whitelist: patch key -> column name. The SET clause is assembled from these
// constants only, so no caller-supplied string ever reaches the SQL text.
const PATCHABLE = {
  question: "question",
  sql: "sql",
  schedule: "schedule",
  threshold: "threshold",
  state: "state",
} as const satisfies Record<keyof WatcherPatch, string>;

export async function updateWatcher(
  id: string,
  patch: WatcherPatch,
): Promise<WatcherRow | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  for (const key of Object.keys(PATCHABLE) as (keyof WatcherPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;

    const column = PATCHABLE[key];
    values.push(key === "threshold" ? JSON.stringify(value) : value);
    // $1 is the id, so the first assignment binds to $2.
    assignments.push(
      key === "threshold"
        ? `${column} = $${values.length}::jsonb`
        : `${column} = $${values.length}`,
    );
  }

  if (assignments.length === 0) return getWatcher(id);

  const rows = await query<WatcherRow>(
    `update watchers set ${assignments.join(", ")}, updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

/** Pause / resume from the watchers table. */
export async function setWatcherState(
  id: string,
  state: WatcherState,
): Promise<WatcherRow | null> {
  return updateWatcher(id, { state });
}

/** The result of one background run, plus the edge it crossed. */
export type WatcherRunOutcome = {
  watcher: WatcherRow;
  /**
   * is_firing as it was *before* this run. The scheduled task alerts only on
   * the transition (!wasFiring && is_firing), never on every tick while firing.
   */
  wasFiring: boolean;
};

/**
 * Record the outcome of one background run. Kept separate from updateWatcher so
 * the scheduled task can't accidentally clobber a user's edits, and so
 * last_run_at always advances even when the reading is unchanged.
 *
 * The previous is_firing is returned from the same statement that overwrites
 * it. That matters: read-then-write would let two overlapping ticks both see
 * `wasFiring = false` and both raise an alert for one transition. The self-join
 * sees the pre-UPDATE snapshot of the row, so the edge is decided atomically —
 * the loser of the race reads the winner's `true` and stays quiet.
 *
 * `state` is nudged only out of 'error': a watcher that starts working again
 * heals itself, but a run must never resurrect one the user paused.
 */
export async function recordWatcherRun(
  id: string,
  run: { value: number | null; isFiring: boolean; ranAt?: Date },
): Promise<WatcherRunOutcome | null> {
  const rows = await query<WatcherRow & { was_firing: boolean }>(
    `update watchers w
     set last_value  = $2,
         is_firing   = $3,
         last_run_at = $4,
         updated_at  = now(),
         state       = case when w.state = 'error' then 'active' else w.state end
     from watchers prev
     where w.id = $1 and prev.id = w.id
     returning ${columnsOf("w")}, prev.is_firing as was_firing`,
    [id, run.value, run.isFiring, run.ranAt ?? new Date()],
  );

  const row = rows[0];
  if (!row) return null;

  const { was_firing, ...watcher } = row;
  return { watcher, wasFiring: was_firing };
}

/**
 * The watcher's SQL would not produce a reading — a broken query, a dropped
 * column, a result that isn't a number.
 *
 * last_value and is_firing are deliberately left alone. An unreadable watcher
 * has not recovered and has not newly fired; it is simply unknown, and the last
 * good reading is still the last thing we actually knew. The UI hides it
 * anyway: FIRING is (state === 'active' && is_firing), and this row is 'error'.
 */
export async function markWatcherError(
  id: string,
  ranAt?: Date,
): Promise<WatcherRow | null> {
  const rows = await query<WatcherRow>(
    `update watchers
     set state = 'error', last_run_at = $2, updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, ranAt ?? new Date()],
  );
  return rows[0] ?? null;
}

/**
 * Bind a watcher to the Trigger.dev schedule that drives it.
 *
 * Set after the insert, because the schedule is created with the watcher's own
 * id as its externalId — the row has to exist first.
 */
export async function setWatcherScheduleId(
  id: string,
  scheduleId: string | null,
): Promise<WatcherRow | null> {
  const rows = await query<WatcherRow>(
    `update watchers set schedule_id = $2, updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, scheduleId],
  );
  return rows[0] ?? null;
}

/** Cascades to this watcher's alerts. Returns false if it did not exist. */
export async function deleteWatcher(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from watchers where id = $1 returning id`,
    [id],
  );
  return rows.length > 0;
}

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

const COLUMNS = `id, chat_id, question, sql, schedule, threshold, state,
                 last_run_at, last_value, is_firing, created_at, updated_at`;

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

/**
 * Record the outcome of one background run. Kept separate from updateWatcher so
 * the scheduled task can't accidentally clobber a user's edits, and so
 * last_run_at always advances even when the reading is unchanged.
 */
export async function recordWatcherRun(
  id: string,
  run: { value: number | null; isFiring: boolean; ranAt?: Date },
): Promise<WatcherRow | null> {
  const rows = await query<WatcherRow>(
    `update watchers
     set last_value = $2, is_firing = $3, last_run_at = $4, updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [id, run.value, run.isFiring, run.ranAt ?? new Date()],
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

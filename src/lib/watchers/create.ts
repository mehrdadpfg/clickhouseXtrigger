/**
 * Create a watcher: the Postgres row plus the Trigger.dev schedule that drives
 * it, as one operation. This is the shared core behind every create path — the
 * Watch page's server action and the chat agent's createWatcher tool — so the
 * "two writes that must agree" invariant lives in exactly one place.
 *
 * It deliberately does NOT call `revalidatePath`: that is Next-request-only and
 * throws inside a Trigger task (where the agent tool runs). Callers that live in
 * a request revalidate themselves after this returns.
 */
import { schedules } from "@trigger.dev/sdk";
import {
  createWatcher,
  deleteWatcher,
  setWatcherScheduleId,
} from "@/lib/db/watchers";
import { cronFor, scheduleKeyFor, watcherTick } from "@/trigger/watchers";
import type { WatcherRow, WatcherThreshold } from "@/types/db";

export type CreateWatcherInput = {
  question: string;
  sql: string;
  schedule: string;
  threshold: WatcherThreshold;
  chatId?: string | null;
};

export type CreateWatcherResult =
  | { ok: true; watcher: WatcherRow }
  | { ok: false; error: string };

/**
 * A watcher's SQL is replayed unattended on a timer. This stops the obvious
 * second statement / non-SELECT; the ClickHouse readonly=2 grant is what
 * actually contains it. Mirrors the guard on the app/actions.ts create path.
 */
function readOnlyish(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (stripped.replace(/;\s*$/, "").includes(";")) return false;
  return /^(select|with)\b/i.test(stripped);
}

/** Cron the watcher's schedule and bind its id back onto the row. */
async function attachSchedule(watcher: WatcherRow): Promise<string> {
  const cron = cronFor(watcher.schedule);
  if (!cron) throw new Error(`Unknown watcher cadence "${watcher.schedule}".`);

  const schedule = await schedules.create({
    task: watcherTick.id,
    cron,
    externalId: watcher.id,
    deduplicationKey: scheduleKeyFor(watcher.id),
  });

  if (schedule.id !== watcher.schedule_id) {
    await setWatcherScheduleId(watcher.id, schedule.id);
  }
  return schedule.id;
}

export async function createWatcherCore(
  input: CreateWatcherInput,
): Promise<CreateWatcherResult> {
  if (!readOnlyish(input.sql)) {
    return {
      ok: false,
      error: "A watcher's SQL must be a single SELECT or WITH statement.",
    };
  }

  // The row goes first: the schedule needs the watcher's id as its externalId.
  const watcher = await createWatcher({
    question: input.question,
    sql: input.sql,
    schedule: input.schedule,
    threshold: input.threshold,
    chatId: input.chatId ?? null,
  });

  try {
    const scheduleId = await attachSchedule(watcher);
    return { ok: true, watcher: { ...watcher, schedule_id: scheduleId } };
  } catch (cause) {
    // A watcher that never runs is worse than none — undo the row rather than
    // leave one that looks like cover it isn't providing.
    console.error("Could not schedule watcher", watcher.id, cause);
    await deleteWatcher(watcher.id).catch(() => {});
    return { ok: false, error: "Could not schedule the watcher. Nothing was saved." };
  }
}

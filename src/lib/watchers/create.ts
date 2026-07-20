/**
 * Watcher mutations — create, update, delete — each keeping the Postgres row and
 * the Trigger.dev schedule that drives it in step. These are the shared cores
 * behind every path: the Watch page's server actions and the chat agent's tools.
 *
 * They deliberately do NOT call `revalidatePath`: that is Next-request-only and
 * throws inside a Trigger task (where the agent tools run). Callers that live in
 * a request revalidate themselves after these return.
 */
import { schedules } from "@trigger.dev/sdk";
import {
  createWatcher,
  deleteWatcher,
  getWatcher,
  setWatcherScheduleId,
  updateWatcher,
  type WatcherPatch,
} from "@/lib/db/watchers";
import { cronFor, scheduleKeyFor, watcherTick } from "@/trigger/watchers";
import type { WatcherRow, WatcherState, WatcherThreshold } from "@/types/db";

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

/**
 * Take the first reading now, rather than at the first scheduled tick.
 *
 * A daily watcher created at noon would otherwise sit on the page reporting
 * "ok" until noon tomorrow — and "ok" is not what it knows, it is what a row
 * with no reading looks like. That is the one lie this feature cannot afford:
 * a watcher that has never looked is indistinguishable from one that looked and
 * found nothing wrong. Firing once at creation makes the first state an actual
 * measurement, and tells the author immediately if their SQL is broken.
 *
 * Non-fatal. The schedule is already attached by this point, so a watcher whose
 * first run could not be queued is merely late, not broken — undoing a valid
 * watcher over it would be the worse outcome.
 */
async function runOnce(watcher: WatcherRow, scheduleId: string): Promise<void> {
  try {
    const now = new Date();
    await watcherTick.trigger({
      type: "IMPERATIVE",
      timestamp: now,
      lastTimestamp: undefined,
      timezone: "UTC",
      scheduleId,
      externalId: watcher.id,
      upcoming: [],
    });
  } catch (cause) {
    console.error("Could not take the first reading for watcher", watcher.id, cause);
  }
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
    await runOnce(watcher, scheduleId);
    return { ok: true, watcher: { ...watcher, schedule_id: scheduleId } };
  } catch (cause) {
    // A watcher that never runs is worse than none — undo the row rather than
    // leave one that looks like cover it isn't providing.
    console.error("Could not schedule watcher", watcher.id, cause);
    await deleteWatcher(watcher.id).catch(() => {});
    return { ok: false, error: "Could not schedule the watcher. Nothing was saved." };
  }
}

/** Bring the Trigger schedule in step with the row: re-cron, then match state. */
async function syncSchedule(watcher: WatcherRow): Promise<void> {
  const scheduleId = await attachSchedule(watcher);
  if (watcher.state !== "active") {
    await schedules.deactivate(scheduleId);
  }
}

export type UpdateWatcherInput = {
  id: string;
  question?: string;
  sql?: string;
  schedule?: string;
  threshold?: WatcherThreshold;
  state?: WatcherState;
};

export type UpdateWatcherResult =
  | { ok: true; watcher: WatcherRow }
  | { ok: false; error: string };

/**
 * Edit a watcher's fields, re-cronning its schedule only when the cadence or the
 * paused/active state actually changed (the row is the source of truth; the
 * schedule follows). SQL is re-guarded on change — a watcher runs unattended.
 */
export async function updateWatcherCore(
  input: UpdateWatcherInput,
): Promise<UpdateWatcherResult> {
  const existing = await getWatcher(input.id);
  if (!existing) return { ok: false, error: "That watcher no longer exists." };

  if (input.sql !== undefined && !readOnlyish(input.sql)) {
    return {
      ok: false,
      error: "A watcher's SQL must be a single SELECT or WITH statement.",
    };
  }

  const patch: WatcherPatch = {};
  if (input.question !== undefined) patch.question = input.question;
  if (input.sql !== undefined) patch.sql = input.sql;
  if (input.schedule !== undefined) patch.schedule = input.schedule;
  if (input.threshold !== undefined) patch.threshold = input.threshold;
  if (input.state !== undefined) patch.state = input.state;

  const updated = await updateWatcher(input.id, patch);
  if (!updated) return { ok: false, error: "That watcher no longer exists." };

  const cadenceChanged =
    input.schedule !== undefined && updated.schedule !== existing.schedule;
  const stateChanged =
    input.state !== undefined && updated.state !== existing.state;
  if (cadenceChanged || stateChanged) {
    // Not fatal: the row is saved and the tick obeys `state`, so the schedule
    // reconverges on the next edit even if this call fails.
    await syncSchedule(updated).catch((cause) => {
      console.error("Could not sync watcher schedule", updated.id, cause);
    });
  }

  // Re-read immediately, however the edit arrived.
  //
  // An edit invalidates the stored reading in exactly the way creation does: a
  // changed query measures something else, and a changed threshold compares the
  // same number against a different bar. Leaving last_value and is_firing in
  // place would have the page reporting a verdict that belongs to the PREVIOUS
  // watcher — and on a daily cadence it would report it until tomorrow.
  //
  // Deliberately not conditional on which field changed. A rename cannot alter
  // the reading, but working that out per-field is a rule that rots the moment
  // a field is added, and a redundant tick costs one query.
  if (updated.state === "active") {
    await runOnce(updated, updated.schedule_id ?? "");
  }

  return { ok: true, watcher: updated };
}

export type DeleteWatcherResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Delete a watcher and its schedule. The schedule goes first — an orphaned
 * schedule wakes forever against a row that isn't there. Deleting one that is
 * already gone is a success: the user asked for it not to exist, and it doesn't.
 */
export async function deleteWatcherCore(id: string): Promise<DeleteWatcherResult> {
  const watcher = await getWatcher(id);
  if (!watcher) return { ok: true, id };

  if (watcher.schedule_id) {
    try {
      await schedules.del(watcher.schedule_id);
    } catch (cause) {
      // The tick self-cleans: it retires any schedule whose watcher is gone.
      console.error("Could not delete schedule", watcher.schedule_id, cause);
    }
  }
  await deleteWatcher(watcher.id);
  return { ok: true, id: watcher.id };
}

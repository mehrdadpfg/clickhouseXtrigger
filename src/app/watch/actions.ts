"use server";

import { revalidatePath } from "next/cache";
import { schedules } from "@trigger.dev/sdk";
import { z } from "zod";
import { acknowledgeAlert } from "@/lib/db/alerts";
import {
  getWatcher,
  setWatcherScheduleId,
  updateWatcher,
} from "@/lib/db/watchers";
import { cronFor, scheduleKeyFor, watcherTick } from "@/trigger/watchers";
import type { WatcherRow, WatcherThreshold } from "@/types/db";
import {
  createWatcherAction as createScheduledWatcher,
  deleteWatcherAction as deleteScheduledWatcher,
  setWatcherPausedAction,
} from "@/app/actions";
// Straight from the model rather than the components/watch barrel: the barrel
// re-exports the screen, and a "use server" module has no business pulling React
// components (and their CSS) into the server bundle to read a list of cadences.
import { CADENCES, type ActionResult } from "@/components/watch/model";

/**
 * The Watchers page's writes.
 *
 * These are adapters, not a second lifecycle. A watcher is two writes that must
 * agree — a Postgres row and a Trigger.dev schedule — and app/actions.ts is the
 * one place that holds both and keeps them honest. What lives here is only the
 * translation between what this page's components send (a flat draft, a target
 * state) and what those actions take.
 *
 * A server action is a public HTTP endpoint with a nice-looking call site — the
 * arguments arrive from the network and none of them are trustworthy just
 * because a component of ours is what usually sends them. Everything below is
 * parsed before it is passed on (and parsed again on the other side, which is
 * the side that matters).
 */

const Id = z.uuid();

const Draft = z.object({
  question: z.string().trim().min(1).max(200),
  sql: z.string().trim().min(1).max(8_000),
  schedule: z.enum(CADENCES.map((c) => c.value) as [string, ...string[]]),
  direction: z.enum(["rises_above", "drops_below", "changes_by"]),
  value: z.number().finite(),
  unit: z.enum(["$", "%", "×"]).optional(),
});

/** The page's components want `{ ok }`; the scheduling actions return `{ ok, data }`. */
function flatten<T>(
  result: { ok: true; data: T } | { ok: false; error: string },
): ActionResult {
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** The modal sends the threshold flat; the store wants it nested. */
function thresholdFrom(draft: z.infer<typeof Draft>): WatcherThreshold {
  return {
    direction: draft.direction,
    value: draft.value,
    ...(draft.unit ? { unit: draft.unit } : {}),
    // The only baseline the schema knows. Meaningful for changes_by alone;
    // storing it on the others would be noise the runner has to ignore.
    ...(draft.direction === "changes_by"
      ? { baseline: "four_week_average" as const }
      : {}),
  };
}

/**
 * A watcher's SQL is replayed unattended on a timer. Editing it re-opens the
 * same footgun as creating it, so the edit path re-applies the same guard the
 * create path gets on the app/actions.ts side. It stops the obvious DROP; the
 * ClickHouse readonly=2 grant is what actually contains this.
 */
function readOnlyish(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();

  // Trailing semicolon is fine; a second statement after one is not.
  if (stripped.replace(/;\s*$/, "").includes(";")) return false;
  return /^(select|with)\b/i.test(stripped);
}

/**
 * Keep a watcher's Trigger.dev schedule in step with its row after an edit.
 *
 * Lives here rather than in app/actions.ts (the usual home for the two-writes
 * dance) only because this page's edit path is scoped to this module. It mirrors
 * that file's attachSchedule: `deduplicationKey` makes it an upsert, so a
 * changed cadence re-crons the one schedule in place instead of stacking a
 * second. Editing never resumes a paused watcher — if the row is off, the
 * freshly upserted schedule goes back off too.
 */
async function syncSchedule(watcher: WatcherRow): Promise<void> {
  const cron = cronFor(watcher.schedule);
  if (!cron) return; // Draft's cadence enum already rejects unknown values.

  const schedule = await schedules.create({
    task: watcherTick.id,
    cron,
    externalId: watcher.id,
    deduplicationKey: scheduleKeyFor(watcher.id),
  });

  if (schedule.id !== watcher.schedule_id) {
    await setWatcherScheduleId(watcher.id, schedule.id);
  }

  if (watcher.state !== "active") {
    await schedules.deactivate(schedule.id);
  }
}

export async function setWatcherStateAction(
  id: string,
  state: "active" | "paused" | "error",
): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown watcher." };

  // 'error' is a state the *runner* reaches, not one a person chooses: it means
  // the last tick threw. There is no schedule change that corresponds to it, so
  // there is nothing here to translate.
  if (state !== "active" && state !== "paused") {
    return { ok: false, error: "Unknown state." };
  }

  return flatten(await setWatcherPausedAction(parsedId.data, state === "paused"));
}

export async function deleteWatcherAction(id: string): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown watcher." };

  return flatten(await deleteScheduledWatcher(parsedId.data));
}

export async function createWatcherAction(draft: unknown): Promise<ActionResult> {
  const parsed = Draft.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid watcher.",
    };
  }

  const { question, sql, schedule } = parsed.data;

  return flatten(
    await createScheduledWatcher({
      question,
      sql,
      schedule,
      threshold: thresholdFrom(parsed.data),
    }),
  );
}

/**
 * Edit an existing watcher in place.
 *
 * Unlike create/pause/delete, this does not delegate to app/actions.ts (there
 * is no update adapter there, and adding one is out of this page's scope): it
 * patches the row through lib/db directly, then re-crons the schedule itself
 * when the cadence changed. Same discipline as the rest — the id and the flat
 * draft both arrive over the network and are parsed before anything is written.
 */
export async function updateWatcherAction(
  id: unknown,
  draft: unknown,
): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown watcher." };

  const parsed = Draft.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid watcher.",
    };
  }

  if (!readOnlyish(parsed.data.sql)) {
    return {
      ok: false,
      error: "A watcher's SQL must be a single SELECT or WITH statement.",
    };
  }

  try {
    const existing = await getWatcher(parsedId.data);
    if (!existing) return { ok: false, error: "That watcher no longer exists." };

    const updated = await updateWatcher(existing.id, {
      question: parsed.data.question,
      sql: parsed.data.sql,
      schedule: parsed.data.schedule,
      threshold: thresholdFrom(parsed.data),
    });
    if (!updated) return { ok: false, error: "That watcher no longer exists." };

    // Only when the cadence moved: re-cronning on every edit would be wasted
    // schedule churn. A failure here is not fatal — the row is already saved and
    // the tick obeys `state`, so the schedule reconverges on the next edit.
    if (updated.schedule !== existing.schedule) {
      await syncSchedule(updated).catch((cause) => {
        console.error("Could not re-cron watcher schedule", updated.id, cause);
      });
    }

    revalidatePath("/watch");
    return { ok: true };
  } catch (cause) {
    console.error("Update watcher failed", cause);
    return {
      ok: false,
      error:
        cause instanceof Error ? cause.message : "Something went wrong. Try again.",
    };
  }
}

export async function acknowledgeAlertAction(id: string): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown alert." };

  try {
    const row = await acknowledgeAlert(parsedId.data);
    if (!row) return { ok: false, error: "That alert no longer exists." };
    revalidatePath("/watch");
    return { ok: true };
  } catch (cause) {
    console.error("Acknowledge alert failed", cause);
    return {
      ok: false,
      error:
        cause instanceof Error ? cause.message : "Something went wrong. Try again.",
    };
  }
}

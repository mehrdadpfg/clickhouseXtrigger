"use server";

import { revalidatePath } from "next/cache";
import { auth, schedules } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { z } from "zod";
import {
  createWatcher,
  deleteWatcher,
  getWatcher,
  setWatcherScheduleId,
  setWatcherState,
} from "@/lib/db/watchers";
import {
  WATCHER_CADENCE_VALUES,
  cronFor,
  scheduleKeyFor,
  watcherTick,
  type WatcherCadence,
} from "@/trigger/watchers";
import type { WatcherRow } from "@/types/db";

// --- chat ------------------------------------------------------------------

// Creates the Session + first run, returns a session PAT. Idempotent on (env, chatId).
export const startChatSession = chat.createStartSessionAction("clickhouse-chat");

// Pure mint. The transport calls this on 401/403 to refresh an expired token.
export async function mintChatAccessToken(chatId: string) {
  return auth.createPublicToken({
    scopes: {
      read: { sessions: chatId },
      write: { sessions: chatId },
    },
    expirationTime: "1h",
  });
}

// --- watchers --------------------------------------------------------------

/**
 * A watcher is two writes that must agree: a Postgres row (what the user sees)
 * and a Trigger.dev schedule (what actually wakes up). These actions are the
 * only place both are held at once, so they are the only place the two can be
 * kept honest.
 *
 * Where they can't be, Postgres wins — `state` is what the tick checks before
 * doing anything, so a schedule that failed to stop still does nothing.
 */

/** Actions return their failure rather than throwing it — the UI has to render it. */
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ThresholdSchema = z.object({
  direction: z.enum(["rises_above", "drops_below", "changes_by"]),
  value: z.number().finite(),
  /** Carried from the source chart so the alert reads in the same units. */
  unit: z.string().max(4).optional(),
  baseline: z.literal("four_week_average").optional(),
});

// Built from the cadence map itself, so adding a cadence can't leave the
// validator behind.
const CadenceSchema = z.enum(
  WATCHER_CADENCE_VALUES as [WatcherCadence, ...WatcherCadence[]],
);

const CreateWatcherSchema = z.object({
  /** The standing question, in the analyst's words. Titles the row and the alert. */
  question: z.string().trim().min(1).max(200),
  /**
   * Replayed verbatim on every tick. Not validated against any table here:
   * nothing in this app knows which table a watcher watches, and readonly=2 on
   * the ClickHouse side is what makes running it unattended safe.
   */
  sql: z.string().trim().min(1),
  schedule: CadenceSchema,
  threshold: ThresholdSchema,
  /** The thread it was born in, for the "Open thread →" jump. */
  chatId: z.uuid().nullish(),
});

/** Promotion is the same shape, minus the option of forgetting where it came from. */
const PromoteWatcherSchema = CreateWatcherSchema.extend({ chatId: z.uuid() });

const WatcherIdSchema = z.uuid();

/** Human-readable first line of a zod failure. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid input.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Attach (or re-attach) the schedule that drives a watcher.
 *
 * `deduplicationKey` makes this an upsert: called twice for the same watcher it
 * updates the one schedule rather than stacking a second, so a retried create
 * or a resume after a half-failed create both converge instead of doubling the
 * watcher's tick rate.
 */
async function attachSchedule(watcher: WatcherRow): Promise<string> {
  const cron = cronFor(watcher.schedule);

  if (!cron) {
    throw new Error(`Unknown watcher cadence "${watcher.schedule}".`);
  }

  const schedule = await schedules.create({
    task: watcherTick.id,
    cron,
    // How the tick knows which watcher it is for.
    externalId: watcher.id,
    deduplicationKey: scheduleKeyFor(watcher.id),
  });

  if (schedule.id !== watcher.schedule_id) {
    await setWatcherScheduleId(watcher.id, schedule.id);
  }

  return schedule.id;
}

async function createWatcherFrom(
  input: z.infer<typeof CreateWatcherSchema>,
): Promise<ActionResult<WatcherRow>> {
  // The row goes first: the schedule needs the watcher's id as its externalId,
  // so there is nothing to point a schedule at until this returns.
  const watcher = await createWatcher({
    question: input.question,
    sql: input.sql,
    schedule: input.schedule,
    threshold: input.threshold,
    chatId: input.chatId ?? null,
  });

  try {
    const scheduleId = await attachSchedule(watcher);
    revalidatePath("/watch");
    return { ok: true, data: { ...watcher, schedule_id: scheduleId } };
  } catch (cause) {
    // A watcher that never runs is worse than no watcher: it sits in the table
    // looking like cover it isn't providing. Undo the row rather than leave one.
    console.error("Could not schedule watcher", watcher.id, cause);
    await deleteWatcher(watcher.id).catch(() => {});
    return { ok: false, error: "Could not schedule the watcher. Nothing was saved." };
  }
}

/** Create a watcher from scratch — the Watch page's own form. */
export async function createWatcherAction(
  input: unknown,
): Promise<ActionResult<WatcherRow>> {
  const parsed = CreateWatcherSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  return createWatcherFrom(parsed.data);
}

/**
 * Promote an answer in a thread into a standing watcher — the "watch this"
 * affordance on a chart, without leaving the conversation.
 *
 * The same create, with the chat required rather than optional: an answer knows
 * which thread produced it, and keeping that link is the whole point — it is
 * what lets an alert, days later, open the conversation that predicted it.
 */
export async function promoteAnswerToWatcherAction(
  input: unknown,
): Promise<ActionResult<WatcherRow>> {
  const parsed = PromoteWatcherSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };

  return createWatcherFrom(parsed.data);
}

/**
 * Pause or resume a watcher.
 *
 * The order flips between the two directions, so that a half-failure always
 * lands on the safe side:
 *   * pausing   — stop the row first. If deactivating then fails, the schedule
 *                 still ticks but the tick sees 'paused' and does nothing.
 *   * resuming  — start the schedule first. Marking a watcher active while
 *                 nothing wakes it would be a lie told in the UI's own words.
 */
export async function setWatcherPausedAction(
  id: unknown,
  paused: boolean,
): Promise<ActionResult<WatcherRow>> {
  const parsedId = WatcherIdSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Not a watcher id." };

  const watcher = await getWatcher(parsedId.data);
  if (!watcher) return { ok: false, error: "That watcher no longer exists." };

  if (paused) {
    const updated = await setWatcherState(watcher.id, "paused");

    if (watcher.schedule_id) {
      try {
        await schedules.deactivate(watcher.schedule_id);
      } catch (cause) {
        // Not fatal, and not worth failing the click over: the row is already
        // paused, and the row is what the tick obeys.
        console.error("Could not deactivate schedule", watcher.schedule_id, cause);
      }
    }

    revalidatePath("/watch");
    return { ok: true, data: updated ?? watcher };
  }

  try {
    if (watcher.schedule_id) {
      await schedules.activate(watcher.schedule_id);
    } else {
      // Never got one, or lost it. Resuming is a fine moment to build it.
      await attachSchedule(watcher);
    }
  } catch (cause) {
    console.error("Could not resume schedule for watcher", watcher.id, cause);
    return { ok: false, error: "Could not restart the watcher. It stays paused." };
  }

  const updated = await setWatcherState(watcher.id, "active");
  revalidatePath("/watch");
  return { ok: true, data: updated ?? watcher };
}

/**
 * Delete a watcher and everything it stood for. Its alerts cascade away with
 * it — they are a log of this watcher, and outlive nothing.
 *
 * The schedule goes first: an orphaned schedule wakes forever against a row
 * that isn't there, whereas a row whose schedule outlived it merely sits still.
 * Deleting one that's already gone is a success, not an error — the user asked
 * for it not to exist, and it doesn't.
 */
export async function deleteWatcherAction(
  id: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsedId = WatcherIdSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Not a watcher id." };

  const watcher = await getWatcher(parsedId.data);
  if (!watcher) return { ok: true, data: { id: parsedId.data } };

  if (watcher.schedule_id) {
    try {
      await schedules.del(watcher.schedule_id);
    } catch (cause) {
      // The tick self-cleans: it retires any schedule whose watcher is gone.
      console.error("Could not delete schedule", watcher.schedule_id, cause);
    }
  }

  await deleteWatcher(watcher.id);
  revalidatePath("/watch");
  return { ok: true, data: { id: watcher.id } };
}

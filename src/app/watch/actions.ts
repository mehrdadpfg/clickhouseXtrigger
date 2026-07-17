"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acknowledgeAlert } from "@/lib/db/alerts";
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

  const { question, sql, schedule, direction, value, unit } = parsed.data;

  // The modal sends the threshold flat; the create action takes it nested.
  return flatten(
    await createScheduledWatcher({
      question,
      sql,
      schedule,
      threshold: {
        direction,
        value,
        ...(unit ? { unit } : {}),
        // The only baseline the schema knows. Meaningful for changes_by alone;
        // storing it on the others would be noise the runner has to ignore.
        ...(direction === "changes_by"
          ? { baseline: "four_week_average" as const }
          : {}),
      },
    }),
  );
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

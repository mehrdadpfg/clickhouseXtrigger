"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acknowledgeAlert } from "@/lib/db/alerts";
import {
  createWatcher,
  deleteWatcher,
  setWatcherState,
} from "@/lib/db/watchers";
// Straight from the model rather than the components/watch barrel: the barrel
// re-exports the screen, and a "use server" module has no business pulling React
// components (and their CSS) into the server bundle to read a list of cadences.
import { CADENCES, type ActionResult } from "@/components/watch/model";

/**
 * The Watchers page's writes.
 *
 * A server action is a public HTTP endpoint with a nice-looking call site — the
 * arguments arrive from the network and none of them are trustworthy just
 * because a component of ours is what usually sends them. Everything below is
 * parsed before it reaches lib/db.
 */

const Id = z.uuid();

const Draft = z.object({
  question: z.string().trim().min(1).max(200),
  sql: z.string().trim().min(1).max(8_000),
  schedule: z.enum(
    CADENCES.map((c) => c.value) as [string, ...string[]],
  ),
  direction: z.enum(["rises_above", "drops_below", "changes_by"]),
  value: z.number().finite(),
  unit: z.enum(["$", "%", "×"]).optional(),
});

/**
 * A watcher's SQL is stored as opaque text and replayed by the scheduled task
 * on a cadence, unattended, forever. That makes "whatever the user typed" a
 * standing offer to run anything against ClickHouse on a timer — so it has to
 * at least *look* like a read before we write it down.
 *
 * This is a guardrail, not a sandbox. It stops the obvious footgun (storing a
 * DROP that fires at 3am); it is not a substitute for pointing the ClickHouse
 * client at a read-only user, which is what actually contains this.
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

/** Actions never throw at the client — a rejected action shows as an alert. */
async function guard(work: () => Promise<void>): Promise<ActionResult> {
  try {
    await work();
    revalidatePath("/watch");
    return { ok: true };
  } catch (cause) {
    console.error("Watch action failed", cause);
    return {
      ok: false,
      error:
        cause instanceof Error ? cause.message : "Something went wrong. Try again.",
    };
  }
}

export async function setWatcherStateAction(
  id: string,
  state: "active" | "paused" | "error",
): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown watcher." };

  const parsedState = z.enum(["active", "paused", "error"]).safeParse(state);
  if (!parsedState.success) return { ok: false, error: "Unknown state." };

  return guard(async () => {
    const row = await setWatcherState(parsedId.data, parsedState.data);
    if (!row) throw new Error("That watcher no longer exists.");
  });
}

export async function deleteWatcherAction(id: string): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown watcher." };

  return guard(async () => {
    // Already gone is the outcome the caller wanted, so it is not an error.
    await deleteWatcher(parsedId.data);
  });
}

export async function createWatcherAction(
  draft: unknown,
): Promise<ActionResult> {
  const parsed = Draft.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid watcher." };
  }

  const { question, sql, schedule, direction, value, unit } = parsed.data;

  if (!readOnlyish(sql)) {
    return {
      ok: false,
      error: "A watcher's SQL must be a single SELECT or WITH statement.",
    };
  }

  return guard(async () => {
    await createWatcher({
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
    });
  });
}

export async function acknowledgeAlertAction(id: string): Promise<ActionResult> {
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Unknown alert." };

  return guard(async () => {
    const row = await acknowledgeAlert(parsedId.data);
    if (!row) throw new Error("That alert no longer exists.");
  });
}

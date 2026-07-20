"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acknowledgeAlert } from "@/lib/db/alerts";
import { updateWatcherCore } from "@/lib/watchers/create";
import { runReadonlyQueryWithCost, type QueryCost } from "@/lib/clickhouse/run";
import { columnNamespace, maxDateIn } from "@/lib/clickhouse/introspect";
import type { WatcherThreshold } from "@/types/db";
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
 * Delegates to updateWatcherCore — the shared mutation that keeps the Postgres
 * row and the Trigger.dev schedule in step, re-guards the SQL, re-crons only
 * when the cadence changed, and (the reason it is the core and not a local patch
 * here) takes a fresh reading the moment the watcher changes. A changed query
 * measures something else and a changed threshold compares against a different
 * bar, so leaving the old last_value/is_firing in place would have the page
 * reporting a verdict that belongs to the PREVIOUS watcher. This action owns
 * only the translation — parsing the network-supplied id and flat draft — and
 * the revalidate the core deliberately does not do (it also runs inside a
 * Trigger task, where revalidatePath throws).
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

  try {
    const result = await updateWatcherCore({
      id: parsedId.data,
      question: parsed.data.question,
      sql: parsed.data.sql,
      schedule: parsed.data.schedule,
      threshold: thresholdFrom(parsed.data),
    });
    if (!result.ok) return { ok: false, error: result.error };

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

/**
 * The watcher editor's studio surface — the same three helpers the board's tile
 * editor gets, wired to the same lib/clickhouse plumbing. They are read-only
 * and dataset-agnostic, so they live on this page's actions module rather than
 * being threaded through the WatchActions prop bag with the lifecycle mutations.
 */

/**
 * Runs the SQL the watcher editor is CURRENTLY showing — the draft in the
 * studio's box — and hands back its rows and what it cost. Takes SQL, not an id,
 * because the studio previews an edit the author has not saved. It is the one
 * watcher action that executes browser-supplied SQL, so it is guarded the same
 * way the tick and the workspace runner are: a single SELECT/WITH and nothing
 * else, bounded by READONLY_SETTINGS (readonly=2, a runtime cap, a row cap) in
 * the client regardless.
 */
export async function runWatcherDraftAction(
  sql: unknown,
): Promise<
  | { ok: true; rows: Record<string, unknown>[]; cost: QueryCost | null }
  | { ok: false; error: string }
> {
  if (typeof sql !== "string") return { ok: false, error: "The query is empty." };
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (trimmed === "") return { ok: false, error: "The query is empty." };
  if (trimmed.includes(";")) {
    return { ok: false, error: "One statement at a time — remove the semicolon." };
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    return { ok: false, error: "A watcher reads with a single SELECT (or WITH … SELECT)." };
  }

  try {
    const { rows, cost } = await runReadonlyQueryWithCost(trimmed);
    return { ok: true, rows, cost };
  } catch (cause) {
    // ClickHouse errors are long and prefixed; the first line carries the point.
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message.split("\n")[0]!.slice(0, 300) };
  }
}

/**
 * The column namespace the watcher editor completes against. Returns {} on
 * failure — autocomplete is a convenience, and an editor that opens without it
 * beats one that won't open at all.
 */
export async function getWatchEditorSchemaAction(): Promise<
  Record<string, Record<string, string[]>>
> {
  try {
    return await columnNamespace();
  } catch (cause) {
    console.error("Could not load the schema for the watcher editor", cause);
    return {};
  }
}

/**
 * The latest value in one column, for the studio's partial-bucket warning.
 * Identifiers are validated against system.columns inside maxDateIn. Returns
 * null on anything unexpected: a missing warning is fine, a wrong one teaches
 * the reader to ignore the next.
 */
export async function getWatchEditorMaxDateAction(
  database: string,
  table: string,
  column: string,
): Promise<string | null> {
  try {
    const max = await maxDateIn(database, table, column);
    return max ? max.toISOString() : null;
  } catch (cause) {
    console.error("Could not read the max date", database, table, column, cause);
    return null;
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

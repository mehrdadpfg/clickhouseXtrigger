/**
 * Compare — the fork / multiverse shift.
 *
 * A chat answers a question one way. Compare answers it several ways *at once*:
 * the same question run under different filters, windows, or assumptions, each
 * as its own durable run, so the analyst can see how much the framing — not the
 * data — was moving the number.
 *
 *
 * WHY batchTrigger, NOT batchTriggerAndWait
 * -----------------------------------------
 * The branches must be INDEPENDENT durable runs, not children the caller blocks
 * on. `batchTriggerAndWait` is the wrong primitive here twice over:
 *
 *   * it can only be called from *inside* a run, and the fork is kicked off by a
 *     server action; and
 *   * it resolves as a set — the caller is handed all the results together, once
 *     the slowest branch is done. That is exactly the "hang waiting for all"
 *     failure this surface is built to avoid.
 *
 * `batchTrigger` returns the moment the runs are enqueued. Each branch then runs
 * on its own, finishes on its own clock, and can fail on its own without
 * touching its siblings. The UI subscribes to the batch (with the
 * `publicAccessToken` this returns) and fills each tile in as its run reports —
 * a fast branch shows its chart while a slow one still spins, and a failed
 * branch shows its error while the survivors keep their numbers.
 *
 *
 * WHY COLOUR IS IN THE PAYLOAD
 * ----------------------------
 * Colour follows the branch ENTITY and is fixed at fork time: each variant is
 * handed its palette slot here, before any branch has run, and the branch echoes
 * it back in metadata. So the tile is drawn in its colour the instant it appears
 * (even while "running…"), the small multiples share one colour assignment, and
 * culling a branch can never repaint the survivors — their slot never depended
 * on who else was in the set.
 *
 *
 * DATASET-AGNOSTIC
 * ----------------
 * A branch is handed opaque SQL and replays it behind readonly=2, exactly like a
 * watcher's tick. It never learns which table it reads. The variant SQL is
 * specialised upstream (by the agent that owns the thread); this file only fans
 * the work out and shapes whatever rows come back.
 */
import { metadata, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { runReadonlyQuery } from "@/lib/clickhouse/run";

// --- shapes shared with the reading side ----------------------------------

/**
 * One variant of the question. `colorSlot` is assigned at fork time and is the
 * whole reason the multiverse reads as one system: it is the entity's identity,
 * carried into every tile, legend and small multiple, and never re-derived from
 * array position.
 */
export const CompareVariant = z.object({
  /** Stable within a compare session — what the UI addresses to select/cull. */
  id: z.string().min(1),
  /** Short human name for the tile, e.g. "Weekends only". */
  label: z.string().min(1),
  /** The value of the dimension being varied, e.g. "excl. airport". Optional. */
  description: z.string().optional(),
  /**
   * The 0-based palette slot this variant owns, fixed at fork time. Matches the
   * chart system's categorical slots (0 → --series-1). Never cycled.
   */
  colorSlot: z.number().int().min(0),
  /**
   * The specialised, readonly SQL for this variant. Replayed verbatim behind
   * readonly=2 — never inspected, never bound to a table name here.
   */
  sql: z.string().min(1),
});
export type CompareVariant = z.infer<typeof CompareVariant>;

/** What every branch shares: the question being forked, and how to read its answer. */
export const CompareBase = z.object({
  /** The question, in the analyst's words. Titles the whole session. */
  question: z.string().min(1),
  /** What the y value means, e.g. "Avg tip". Names the shared axis. */
  metricLabel: z.string().min(1),
  /** The unit the headline wears: "$" leads, "%"/"×" trail. Optional. */
  unit: z.string().max(4).optional(),
  /** The dimension being varied across the set, e.g. "trip filter". */
  varying: z.string().min(1),
});
export type CompareBase = z.infer<typeof CompareBase>;

export type CompareBranchPoint = { x: string | number; y: number | null };

export type CompareBranchStatus = "running" | "complete" | "failed";

/**
 * The whole of a branch run's metadata. The compare sidebar reads exactly this
 * (adapted to its view model) and nothing else — the run's own status is a
 * belt-and-braces second signal, but a branch that failed says so here too.
 */
export type CompareBranchMetadata = {
  status: CompareBranchStatus;
  variant: CompareVariant;
  base: CompareBase;
  /** The series for this variant's small multiple. Empty until the query lands. */
  points: CompareBranchPoint[];
  /** The one number the tile leads with — the latest reading, or the scalar. */
  headline: number | null;
  /** Percent change vs the base reading, when the fork supplied one. */
  delta: number | null;
  /** How many rows the query returned — the receipt on the SQL. */
  rowCount: number;
  /** Present only when status is "failed" — the ClickHouse error. */
  error: string | null;
};

// --- reading the rows ------------------------------------------------------

/**
 * ClickHouse hands back 64-bit integers and Decimals as strings in the JSON
 * formats — they don't survive a JS number. A numeric string counts as a number
 * here, but only when it round-trips, so an id-like string is never silently
 * treated as a measurement.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && String(parsed) === trimmed ? parsed : null;
}

/**
 * Shape whatever the variant's SQL returned into a series.
 *
 * The convention is the same one the chart artifacts already read: the first
 * column is the x (a bucket label or a timestamp), the second is the y (the
 * measure). A one-column, one-row answer is a scalar — a single point so the
 * tile still has a headline. Nothing here depends on a column *name*: a taxi
 * fare series and a pod-latency series shape identically.
 */
function shapeSeries(rows: Record<string, unknown>[]): CompareBranchPoint[] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]!);
  if (keys.length === 0) return [];

  // Scalar: one column. The label is the column name; the point carries it.
  if (keys.length === 1) {
    const key = keys[0]!;
    return rows.map((row) => ({ x: key, y: asNumber(row[key]) }));
  }

  const [xKey, yKey] = keys as [string, string];
  return rows.map((row) => {
    const xRaw = row[xKey];
    const xNum = asNumber(xRaw);
    return {
      // A numeric x stays numeric (a real scale); anything else is a label.
      x: xNum ?? (xRaw == null ? "" : String(xRaw)),
      y: asNumber(row[yKey]),
    };
  });
}

/** The tile's headline: the last real reading in the series. */
function headlineOf(points: CompareBranchPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const y = points[i]!.y;
    if (y !== null && Number.isFinite(y)) return y;
  }
  return null;
}

// --- the branch ------------------------------------------------------------

const BranchPayload = z.object({
  base: CompareBase,
  variant: CompareVariant,
  /**
   * The base question's own reading, if the fork has one. Lets each branch show
   * its delta from the baseline the analyst started from — the "−21.3%" that
   * makes the comparison legible at a glance.
   */
  baseHeadline: z.number().nullish(),
});
export type CompareBranchPayload = z.infer<typeof BranchPayload>;

export const compareBranch = schemaTask({
  id: "compare-branch",
  schema: BranchPayload,
  maxDuration: 120,
  // A branch that fails fails for a reason that a retry won't fix — the variant
  // SQL is wrong, or the filter selects nothing. Retrying just delays the moment
  // the tile can show the error. One attempt; the analyst re-forks if needed.
  retry: { maxAttempts: 1 },
  // Every branch points at one ClickHouse. A wide fork must not arrive as a wall
  // of concurrent scans — a few at a time, the rest queue and fill in as they go.
  queue: { name: "compare", concurrencyLimit: 4 },

  run: async ({ base, variant, baseHeadline }) => {
    // Publish identity and colour FIRST, before the query runs. The tile can now
    // be drawn — named, in its fixed colour, spinning — the instant the UI sees
    // this run, rather than appearing blank until the data lands.
    const initial: CompareBranchMetadata = {
      status: "running",
      variant,
      base,
      points: [],
      headline: null,
      delta: null,
      rowCount: 0,
      error: null,
    };
    metadata.replace(initial);

    let rows: Record<string, unknown>[];
    try {
      rows = await runReadonlyQuery(variant.sql);
    } catch (cause) {
      // The commonest branch death: a filter that doesn't type-check, a column
      // the variant assumed. Record it so the tile shows a failed branch with
      // its error — then rethrow, so the run itself is durably marked failed and
      // the branch reads as failed from either signal.
      const message =
        cause instanceof Error ? cause.message : "Query failed.";
      metadata.set("status", "failed").set("error", message);
      throw cause;
    }

    const points = shapeSeries(rows);
    const headline = headlineOf(points);
    const delta =
      typeof baseHeadline === "number" &&
      baseHeadline !== 0 &&
      headline !== null
        ? ((headline - baseHeadline) / Math.abs(baseHeadline)) * 100
        : null;

    metadata
      .set("points", points)
      .set("headline", headline)
      .set("delta", delta)
      .set("rowCount", rows.length)
      .set("status", "complete");

    return {
      variantId: variant.id,
      headline,
      delta,
      rowCount: rows.length,
    };
  },
});

// --- the fork --------------------------------------------------------------

const ForkInput = z.object({
  /** Ties the branches together — becomes a shared tag for the whole session. */
  sessionId: z.string().min(1),
  base: CompareBase,
  /** One run per variant. Colours are already assigned; slots stay put. */
  variants: z.array(CompareVariant).min(1).max(8),
  /** The baseline reading the branches measure their delta against, if any. */
  baseHeadline: z.number().nullish(),
});
export type CompareForkInput = z.infer<typeof ForkInput>;

export type CompareForkResult = {
  batchId: string;
  runCount: number;
  /**
   * Scoped to read exactly this batch's runs. The server action hands it to the
   * browser, which subscribes with it — so the credential the frontend gets can
   * see these runs and nothing else.
   */
  publicAccessToken: string;
  /** The tag every branch carries — the other way the UI can find the set. */
  sessionTag: string;
};

/**
 * Fan one question out into one durable run per variant, in parallel.
 *
 * Called from a server action, not from inside a run — which is exactly why this
 * is `batchTrigger` and not `batchTriggerAndWait`. It returns as soon as the
 * runs are enqueued, handing back the batch id and a scoped token the browser
 * uses to watch them fill in.
 */
export async function forkCompare(
  input: CompareForkInput,
): Promise<CompareForkResult> {
  const parsed = ForkInput.parse(input);
  const sessionTag = `compare:${parsed.sessionId}`;

  const handle = await compareBranch.batchTrigger(
    parsed.variants.map((variant) => ({
      payload: {
        base: parsed.base,
        variant,
        baseHeadline: parsed.baseHeadline ?? null,
      },
      options: {
        // The session tag finds the whole set; the variant tag finds one branch.
        tags: [sessionTag, `variant:${variant.id}`],
      },
    })),
  );

  return {
    batchId: handle.batchId,
    runCount: handle.runCount,
    publicAccessToken: handle.publicAccessToken,
    sessionTag,
  };
}

/**
 * Watchers — the pull → push shift.
 *
 * A chat answers a question once. A watcher keeps asking it: this task re-runs
 * a watcher's stored SQL on its cadence, compares the reading to the threshold,
 * and raises an alert the moment it crosses. That is the whole difference
 * between a chatbot and something that tells you your tips are down before you
 * think to ask.
 *
 *
 * WHY IMPERATIVE SCHEDULES, NOT DECLARATIVE
 * -----------------------------------------
 * A declarative schedule (`cron` on the task) is fixed at deploy time — one
 * pattern, baked into the code. Watchers are the opposite: users create them at
 * runtime, each choosing its own cadence, and a deploy is not in that loop.
 *
 * Declarative would force one of two bad shapes:
 *   * tick at the greatest common cadence (every 5 minutes), load every active
 *     watcher, and re-implement "is this one due yet?" in Postgres — rebuilding
 *     a scheduler Trigger.dev already has, and waking hourly watchers 12× for
 *     nothing; or
 *   * one hardcoded cron per cadence, and no way to add a fifth without a
 *     deploy.
 *
 * So: one imperative schedule per watcher (schedules.create), keyed by
 * `externalId = watcher.id`. This is the documented multi-tenant pattern — the
 * per-user reminder, with a watcher standing in for the user. Each run is told
 * exactly which watcher it is for, and cadence, pause and delete are schedule
 * operations rather than bookkeeping we maintain by hand.
 *
 * The schedules are created and torn down by the server actions in
 * app/actions.ts, which own the watcher's lifecycle. This file owns the tick.
 */
import { schedules } from "@trigger.dev/sdk";
import { z } from "zod";
import { clickhouse, READONLY_SETTINGS } from "@/lib/clickhouse/client";
import { createAlert } from "@/lib/db/alerts";
import {
  getWatcher,
  markWatcherError,
  recordWatcherRun,
} from "@/lib/db/watchers";
import { env } from "@/lib/env";
import type { WatcherThreshold } from "@/types/db";

// --- cadence ---------------------------------------------------------------

/**
 * The cadences a watcher may be authored with, and the cron each maps to.
 *
 * The row stores the *intent* ('6h'), not the cron — so the table can render
 * "every 6h" without decompiling `0 * /6 * * *`, and so the mapping stays fixed
 * in one readable place. Trigger.dev has no seconds field; a minute is the
 * floor, which is well below anything worth standing a watcher up for.
 */
export const WATCHER_CADENCES = {
  "5m": "*/5 * * * *",
  "1h": "0 * * * *",
  "6h": "0 */6 * * *",
  // Early enough to be waiting when the working day starts. UTC, like all of
  // these — a watcher is not tied to one reader's timezone.
  daily: "0 6 * * *",
} as const;

export type WatcherCadence = keyof typeof WATCHER_CADENCES;

export const WATCHER_CADENCE_VALUES = Object.keys(
  WATCHER_CADENCES,
) as WatcherCadence[];

export function isWatcherCadence(value: string): value is WatcherCadence {
  return Object.prototype.hasOwnProperty.call(WATCHER_CADENCES, value);
}

/** The cron for an authored cadence, or null if the column holds something else. */
export function cronFor(cadence: string): string | null {
  return isWatcherCadence(cadence) ? WATCHER_CADENCES[cadence] : null;
}

/**
 * Deduplication keys are scoped per *project*, not per environment (see the
 * scheduled-tasks docs). Dev and a deployed environment reading the same
 * Postgres would otherwise fight over one schedule per watcher id — the last
 * writer deciding which environment it ticks in. The env tag keeps them apart.
 *
 * TRIGGER_SECRET_KEY is `tr_dev_…` / `tr_prod_…`, so it already names the
 * environment; there is nothing else to read it from.
 */
const ENV_TAG = env.TRIGGER_SECRET_KEY.split("_")[1] ?? "dev";

export function scheduleKeyFor(watcherId: string): string {
  return `watcher-${ENV_TAG}-${watcherId}`;
}

// --- threshold evaluation --------------------------------------------------

/**
 * The threshold column defaults to '{}', and jsonb is unvalidated by
 * definition, so it is parsed rather than trusted. A watcher we cannot compare
 * against is an error, not a silent pass.
 */
const ThresholdSchema = z.object({
  direction: z.enum(["rises_above", "drops_below", "changes_by"]),
  value: z.number().finite(),
  unit: z.string().max(4).optional(),
  baseline: z.literal("four_week_average").optional(),
}) satisfies z.ZodType<WatcherThreshold, WatcherThreshold>;

/**
 * Is this reading over the line?
 *
 * `changes_by` compares magnitudes: the reading is already a delta (the SQL
 * does the "vs 4-week average" arithmetic), so "changed by 20%" is true of −23%
 * and of +23% alike. A user who means only one direction has `drops_below` /
 * `rises_above`, which compare signed values and say so in their names.
 */
function isOverThreshold(value: number, threshold: WatcherThreshold): boolean {
  switch (threshold.direction) {
    case "rises_above":
      return value > threshold.value;
    case "drops_below":
      return value < threshold.value;
    case "changes_by":
      return Math.abs(value) >= Math.abs(threshold.value);
  }
}

/** '$' leads, '%' and '×' trail. Mirrors how the reading was shown in chat. */
function formatReading(value: number, unit?: string): string {
  const n = value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!unit) return n;
  return unit === "$" ? `$${n}` : `${n}${unit}`;
}

function alertMessage(
  question: string,
  value: number,
  threshold: WatcherThreshold,
): string {
  return (
    `${question} — ${formatReading(value, threshold.unit)} ` +
    `vs ${formatReading(threshold.value, threshold.unit)} threshold`
  );
}

// --- reading the watcher's SQL ---------------------------------------------

/**
 * A watcher's query answers one question with one number, so the reading is the
 * first column of the first row. Whatever the analyst called it — the column
 * name is theirs, and nothing here may depend on it.
 *
 * Both number and string are accepted. This server hands back Int64 and
 * Decimal as JSON numbers, but that is a setting
 * (output_format_json_quote_64bit_integers), not a guarantee — quote them, or
 * point a watcher at a server that does, and every reading arrives as a string.
 * A watcher that silently stopped reading over a JSON setting would be a
 * miserable thing to debug.
 *
 * The null and empty-string guards are load-bearing rather than defensive
 * habit: `Number(null)` and `Number("")` are both 0, so without them a query
 * that returned nothing would read as a confident measurement of zero — and
 * trip every drops_below watcher in the table.
 */
function readScalar(row: Record<string, unknown>): number | null {
  const raw = Object.values(row)[0];

  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // null, undefined, booleans, nested objects — not a reading.
  return null;
}

// --- the tick --------------------------------------------------------------

export const watcherTick = schedules.task({
  id: "watcher-tick",
  // A tick is only worth running while it is still the current reading. If one
  // is stuck behind a backlog past the next tick, the next tick is strictly
  // better data — expire this one rather than measure the past twice.
  ttl: "4m",
  maxDuration: 120,
  // The next tick is the retry. Hammering a watcher whose SQL is broken just
  // burns runs to reach the same answer the cadence would reach anyway; one
  // retry covers a transient ClickHouse blip, and that is all this deserves.
  retry: { maxAttempts: 2 },
  // Watchers all point at one ClickHouse. A hundred of them sharing a cadence
  // must not arrive as a hundred concurrent queries.
  queue: { name: "watchers", concurrencyLimit: 5 },

  run: async (payload) => {
    const watcherId = payload.externalId;

    if (!watcherId) {
      // Every schedule this task attaches to is created with externalId set, so
      // this is a schedule made by hand in the dashboard. It has no watcher to
      // run and never will.
      throw new Error(
        `Schedule ${payload.scheduleId} has no externalId — it cannot name a watcher to run.`,
      );
    }

    const watcher = await getWatcher(watcherId);

    if (!watcher) {
      // The row is gone but its schedule kept ticking — delete failed halfway,
      // or the database was reset under it. Retire the schedule so it stops
      // waking us forever. Best-effort: a dashboard test run passes a synthetic
      // scheduleId that won't resolve, and that must not fail the run.
      await schedules.del(payload.scheduleId).catch(() => {});
      return { skipped: "watcher-deleted" as const, watcherId };
    }

    // Pausing deactivates the schedule, so this is belt-and-braces: if that API
    // call failed, the row still said 'paused', and the row is what decides.
    if (watcher.state === "paused") {
      return { skipped: "paused" as const, watcherId };
    }

    const threshold = ThresholdSchema.safeParse(watcher.threshold);

    if (!threshold.success) {
      await markWatcherError(watcherId, payload.timestamp);
      return { error: "unusable-threshold" as const, watcherId };
    }

    // The stored SQL is replayed as opaque text — this task has no idea which
    // table it reads, and must not. readonly=2 is the same guard the chat agent
    // runs every model-authored query behind; it is what makes replaying text
    // an analyst wrote safe to do unattended.
    let rows: Record<string, unknown>[];

    try {
      const resultSet = await clickhouse.query({
        query: watcher.sql,
        format: "JSONEachRow",
        clickhouse_settings: READONLY_SETTINGS,
      });
      rows = await resultSet.json<Record<string, unknown>>();
    } catch (cause) {
      // The commonest way a watcher dies: a column got renamed, a table was
      // dropped, the SQL was always subtly wrong. Mark it so the Watch page can
      // say so — a watcher that quietly stopped watching is the one failure
      // this feature cannot afford, because it looks exactly like good news.
      await markWatcherError(watcherId, payload.timestamp);
      // Rethrow: the run belongs in the dashboard as a failure, with the
      // ClickHouse error attached. A later tick that succeeds heals the row.
      throw cause;
    }

    const first = rows[0];
    const value = first ? readScalar(first) : null;

    if (value === null) {
      // No rows, a NULL, or something that isn't a number. We did not measure
      // "zero" — we failed to measure. Saying otherwise would fire a
      // drops_below watcher on a typo.
      await markWatcherError(watcherId, payload.timestamp);
      return { error: "no-reading" as const, watcherId };
    }

    const isFiring = isOverThreshold(value, threshold.data);

    const outcome = await recordWatcherRun(watcherId, {
      value,
      isFiring,
      ranAt: payload.timestamp,
    });

    if (!outcome) {
      // Deleted while its own query was in flight. Nothing to alert on.
      return { skipped: "watcher-deleted" as const, watcherId };
    }

    // THE point of the alerts table: only the crossing is news. A watcher that
    // has been firing for a week is a state you can already see on the Watch
    // page — re-alerting every 5 minutes would bury the one that just tripped.
    const transitionedIntoFiring = isFiring && !outcome.wasFiring;

    if (transitionedIntoFiring) {
      await createAlert({
        watcherId,
        value,
        message: alertMessage(watcher.question, value, threshold.data),
        firedAt: payload.timestamp,
      });
    }

    return {
      watcherId,
      value,
      isFiring,
      // Recovery is a state change worth returning even though it raises no
      // alert — the row flips out of FIRING on its own.
      recovered: !isFiring && outcome.wasFiring,
      alerted: transitionedIntoFiring,
    };
  },
});

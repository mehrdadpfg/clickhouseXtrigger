/**
 * The Watch page's view model.
 *
 * Rows come out of Postgres with Dates and raw numbers; the screen wants
 * strings. The mapping lives here rather than in the route so the route stays
 * thin, and rather than in the components so they stay dumb.
 *
 * Everything time-shaped is formatted by the *server*, at request time, and
 * shipped as a finished string — same discipline as the history sidebar. A
 * "2m ago" computed in the browser would disagree with the one the server
 * rendered and blow up hydration.
 *
 * Nothing here knows what is being watched. A watcher is a question, some SQL,
 * a cadence and a threshold; whether that SQL reads trips, invoices or spans is
 * not this file's business.
 */
import type {
  AlertRow,
  WatcherDirection,
  WatcherRow,
  WatcherState,
  WatcherThreshold,
} from "@/types/db";

// --- vocabulary ------------------------------------------------------------

/**
 * FIRING is not a stored state — it is (state === 'active' && is_firing). A
 * paused watcher holds its last reading but cannot fire, so it never shows red.
 */
export type WatcherStatus = "firing" | "ok" | "paused" | "error";

export function watcherStatus(row: WatcherRow): WatcherStatus {
  if (row.state === "paused") return "paused";
  if (row.state === "error") return "error";
  return row.is_firing ? "firing" : "ok";
}

export const STATUS_LABEL: Record<WatcherStatus, string> = {
  firing: "FIRING",
  ok: "OK",
  paused: "PAUSED",
  error: "ERROR",
};

/**
 * The cadences `watchers.schedule` is authored with (see types/db). The design's
 * modal offered three; the schema names four, and the schema is what the
 * scheduled task actually sweeps — so all four are offered.
 */
export const CADENCES = [
  { value: "5m", label: "5 min", short: "5m", phrase: "every 5 min" },
  { value: "1h", label: "hourly", short: "1h", phrase: "hourly" },
  { value: "6h", label: "6 hours", short: "6h", phrase: "every 6h" },
  { value: "daily", label: "daily", short: "daily", phrase: "daily" },
] as const;

export type CadenceValue = (typeof CADENCES)[number]["value"];

/** Unknown cadences render as authored rather than as a lie or a blank. */
function cadence(schedule: string) {
  return CADENCES.find((c) => c.value === schedule);
}

export function cadenceShort(schedule: string): string {
  return cadence(schedule)?.short ?? schedule;
}

export function cadencePhrase(schedule: string): string {
  return cadence(schedule)?.phrase ?? `every ${schedule}`;
}

export const DIRECTIONS = [
  { value: "rises_above", label: "rises above" },
  { value: "drops_below", label: "drops below" },
  { value: "changes_by", label: "changes by" },
] as const satisfies readonly { value: WatcherDirection; label: string }[];

export function directionLabel(direction: WatcherDirection): string {
  return DIRECTIONS.find((d) => d.value === direction)?.label ?? direction;
}

/**
 * The units a reading can carry, as stored in threshold.unit. The label is what
 * the picker shows; the glyph alone ("×" vs "%") is too terse to choose between.
 */
export const UNITS = [
  { value: "", label: "number" },
  { value: "$", label: "$ currency" },
  { value: "%", label: "% percent" },
  { value: "×", label: "× multiplier" },
] as const;

// --- numbers ---------------------------------------------------------------

const NUMBER = new Intl.NumberFormat("en-US");

/** U+2212. A hyphen is not a minus sign and does not line up in tabular figures. */
const MINUS = "−";

function sign(value: number): string {
  return value < 0 ? MINUS : "";
}

/**
 * A reading, in the unit the source chart was carrying. `null` is "no run yet",
 * which is an em dash and not a zero — a watcher that has never run has no
 * reading, and 0 would be a number we made up.
 */
export function formatReading(value: number | null, unit?: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);

  switch (unit) {
    case "$":
      return `${sign(value)}$${magnitude.toFixed(2)}`;
    case "%":
      return `${sign(value)}${magnitude.toFixed(1)}%`;
    case "×":
      return `${sign(value)}${magnitude.toFixed(1)}×`;
    default:
      return `${sign(value)}${NUMBER.format(magnitude)}`;
  }
}

const AUTHORED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * Money is the exception to "as authored". Cents are a fixed two digits or they
 * are not money — "$3.5" reads as a typo, where "20%" reads as a round number.
 */
const AUTHORED_CURRENCY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A threshold, as a human typed it: "−20%", not "−20.0%".
 *
 * Deliberately not formatReading. A *reading* is measured and lives in a column
 * of other readings, so it pads to a fixed width to stay aligned. A threshold
 * is authored and sits in prose, where padding a round 20 out to "20.0" just
 * reads like a precision nobody asked for.
 */
export function formatThresholdValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = AUTHORED.format(Math.abs(value));

  switch (unit) {
    case "$":
      return `${sign(value)}$${AUTHORED_CURRENCY.format(Math.abs(value))}`;
    case "%":
      return `${sign(value)}${magnitude}%`;
    case "×":
      return `${sign(value)}${magnitude}×`;
    default:
      return `${sign(value)}${magnitude}`;
  }
}

/** The threshold as configured, e.g. "−20%" or "$3.50". */
export function formatThreshold(threshold: WatcherThreshold): string {
  return formatThresholdValue(threshold.value, threshold.unit);
}

/** "vs −20% threshold (4-week avg)" — the note under a firing number. */
export function thresholdNote(threshold: WatcherThreshold): string {
  // The baseline is parenthetical, not a second "vs" clause: "vs −20% threshold
  // vs 4-week average" makes the reader parse two comparisons where there is one.
  const base =
    threshold.baseline === "four_week_average" ? " (4-week avg)" : "";
  return `vs ${formatThreshold(threshold)} threshold${base}`;
}

/** The plain-English rule, e.g. "drops below $3.50". */
export function ruleLabel(threshold: WatcherThreshold): string {
  return `${directionLabel(threshold.direction)} ${formatThreshold(threshold)}`;
}

// --- time ------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;

const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const AS_OF = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "2m ago" / "1h ago" / "Jul 14". Null means the watcher has never run. */
export function agoLabel(at: Date | null, now: Date = new Date()): string {
  if (!at) return "never";
  const elapsed = now.getTime() - at.getTime();

  // Clock skew between Postgres and this process can date a row a little into
  // the future; "just now" beats "−1m ago".
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return MONTH_DAY.format(at);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "today 09:12" / "Jul 15" — the alert feed's timestamp. */
export function alertStamp(at: Date, now: Date = new Date()): string {
  return sameDay(at, now) ? `today ${TIME.format(at)}` : MONTH_DAY.format(at);
}

/** "as of Jul 16, 09:00" — what a frozen reading is stamped with. */
export function asOfLabel(at: Date): string {
  return `as of ${AS_OF.format(at)}`;
}

// --- views -----------------------------------------------------------------

export type WatcherView = {
  id: string;
  /** Null once the birth thread is deleted — watchers outlive chats. */
  chatId: string | null;
  question: string;
  status: WatcherStatus;
  /** Pre-formatted reading, in the threshold's unit. */
  reading: string;
  /** Whether the reading is a live re-run or a snapshot held by a pause. */
  isLive: boolean;
  cadence: string;
  cadencePhrase: string;
  lastRun: string;
  thresholdNote: string;
  /** When this watcher last tripped. Hero only; null if it never has. */
  firedAgo: string | null;
};

export function toWatcherView(
  row: WatcherRow,
  options: { firedAt?: Date | null; now?: Date } = {},
): WatcherView {
  const now = options.now ?? new Date();
  const status = watcherStatus(row);

  return {
    id: row.id,
    chatId: row.chat_id,
    question: row.question,
    status,
    reading: formatReading(row.last_value, row.threshold.unit),
    // A paused watcher is not re-running, so its number is frozen at whatever
    // the last sweep saw. That is the whole living/frozen distinction.
    isLive: row.state === "active",
    cadence: cadenceShort(row.schedule),
    cadencePhrase: cadencePhrase(row.schedule),
    lastRun: agoLabel(row.last_run_at, now),
    thresholdNote: thresholdNote(row.threshold),
    firedAgo: options.firedAt ? agoLabel(options.firedAt, now) : null,
  };
}

export type AlertView = {
  id: string;
  message: string;
  stamp: string;
  /** The watcher's question — the alert's "Source" in the design. */
  source: string;
  chatId: string | null;
  acknowledged: boolean;
};

export function toAlertView(
  row: AlertRow,
  watcher: WatcherRow | undefined,
  now: Date = new Date(),
): AlertView {
  return {
    id: row.id,
    message: row.message,
    stamp: alertStamp(row.fired_at, now),
    source: watcher?.question ?? "—",
    chatId: watcher?.chat_id ?? null,
    acknowledged: row.acknowledged,
  };
}

// --- actions ---------------------------------------------------------------

/**
 * Server actions reach these components as props, handed down by the route.
 * Importing them from `@/app/...` instead would point components at app, and
 * dependencies run app -> components -> lib.
 */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** What the watch modal collects. */
export type WatcherDraft = {
  question: string;
  sql: string;
  schedule: string;
  direction: WatcherDirection;
  value: number;
  unit?: string;
};

export type WatchActions = {
  setState: (id: string, state: WatcherState) => Promise<ActionResult>;
  remove: (id: string) => Promise<ActionResult>;
  create: (draft: WatcherDraft) => Promise<ActionResult>;
  acknowledge: (id: string) => Promise<ActionResult>;
};

/**
 * A metric handed to the watch modal by whatever the user was looking at (a
 * chart in a thread). When absent the modal asks for the question and SQL
 * itself — there is no default metric, because there is no default table.
 */
export type WatchMetric = {
  label: string;
  sql: string;
  unit?: string;
  /** The reading as of `observedAt`. A snapshot: nothing is re-running yet. */
  current: number | null;
  observedAt: Date;
};

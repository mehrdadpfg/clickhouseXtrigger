/**
 * Is the chart's last bucket a whole period, or a period still in progress?
 *
 * The most common way a time chart lies. A per-year chart of a table that ends
 * in July draws its final bar at roughly half height, and it reads as a
 * collapse — every one of these NYC tables is in exactly that state right now.
 * Nothing on the chart says so, and no amount of staring at it would tell you.
 *
 * Pure — no I/O. The caller supplies the table's real max date; this decides
 * what it means. Every step fails to `null` rather than guessing: a warning
 * that might be wrong is worse than no warning, because it teaches the reader
 * to ignore the next one.
 */

export type Bucket = "hour" | "day" | "week" | "month" | "quarter" | "year";

/** The ClickHouse date functions a bucketed chart actually gets written with. */
const BUCKET_FNS: [RegExp, Bucket][] = [
  [/\btoStartOfHour\s*\(/i, "hour"],
  [/\btoStartOfQuarter\s*\(/i, "quarter"],
  [/\btoStartOfWeek\s*\(/i, "week"],
  [/\btoMonday\s*\(/i, "week"],
  [/\btoStartOfMonth\s*\(/i, "month"],
  [/\btoStartOfYear\s*\(/i, "year"],
  [/\btoYYYYMM\s*\(/i, "month"],
  [/\btoYear\s*\(/i, "year"],
  [/\btoMonth\s*\(/i, "month"],
  [/\btoStartOfDay\s*\(/i, "day"],
  [/\btoDate\s*\(/i, "day"],
];

/**
 * The bucket and the underlying date column, read off the chart's own SQL.
 *
 * Taken from the function the query was written with rather than inferred from
 * the spacing of the x values: `toYear(executed_date)` says "year" exactly,
 * where spacing has to guess, and guesses badly on sparse or irregular series.
 */
export function readBucket(
  sql: string,
): { bucket: Bucket; column: string } | null {
  for (const [pattern, bucket] of BUCKET_FNS) {
    const at = pattern.exec(sql);
    if (!at) continue;
    // The first identifier inside the call is the date column.
    const rest = sql.slice(at.index + at[0].length);
    const arg = /^\s*([A-Za-z_][\w]*)/.exec(rest);
    if (arg?.[1]) return { bucket, column: arg[1] };
  }
  return null;
}

/** When the bucket that contains `start` ends. */
export function bucketEnd(start: Date, bucket: Bucket): Date {
  const d = new Date(start.getTime());
  switch (bucket) {
    case "hour":
      d.setUTCHours(d.getUTCHours() + 1);
      break;
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d;
}

/**
 * An x value as a date. A bucketed x arrives either as a date string or, for
 * toYear, as a bare number — and `new Date(2026)` is 1970, so a year has to be
 * recognised rather than parsed.
 */
export function asBucketStart(value: unknown, bucket: Bucket): Date | null {
  if (value instanceof Date) return value;
  const text = String(value ?? "").trim();
  if (text === "") return null;

  if (bucket === "year" && /^\d{4}$/.test(text)) {
    return new Date(Date.UTC(Number(text), 0, 1));
  }
  if (bucket === "month" && /^\d{6}$/.test(text)) {
    // toYYYYMM
    return new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4)) - 1, 1));
  }
  const ms = Date.parse(text.includes("T") || text.includes(" ") ? text : `${text}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const BUCKET_NOUN: Record<Bucket, string> = {
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

export type Coverage = {
  /** The x label of the incomplete bucket, as the chart shows it. */
  label: string;
  /** How far through that bucket the data reaches, 0–1. */
  fraction: number;
  /** The table's last date, ISO day. */
  endsAt: string;
  noun: string;
};

/**
 * Whether the chart's final bucket is still filling, given the table's real max.
 *
 * Compared against the SOURCE table's max rather than today's date: these are
 * historical loads, so "is the period over?" is the wrong question — a 2025
 * chart of a table that stopped in October is just as misleading, and would
 * pass a clock-based check.
 */
export function readCoverage(
  lastX: unknown,
  bucket: Bucket,
  tableMax: Date,
): Coverage | null {
  const start = asBucketStart(lastX, bucket);
  if (!start) return null;

  const end = bucketEnd(start, bucket);
  // Complete: the source has data at or past the bucket's end.
  if (tableMax.getTime() >= end.getTime() - 1) return null;
  // Nonsense: the source ends before this bucket even starts.
  if (tableMax.getTime() <= start.getTime()) return null;

  const fraction =
    (tableMax.getTime() - start.getTime()) / (end.getTime() - start.getTime());

  return {
    label: String(lastX),
    fraction,
    endsAt: tableMax.toISOString().slice(0, 10),
    noun: BUCKET_NOUN[bucket],
  };
}

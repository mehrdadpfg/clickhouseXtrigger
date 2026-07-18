/**
 * The Explore entry-point view model.
 *
 * Explore starts where a warehouse actually is: a pile of tables that mostly
 * don't relate. So the human curates the scope — picks the tables worth
 * bringing together — and only then does the agent discover how they connect.
 * This file shapes `system.tables` rows into pickable choices and carries the
 * chosen scope to the discovery step. It knows no table or column name: every
 * label is derived from whatever the introspection returned.
 *
 * Pure data in, plain data out. `TableSummary` is imported type-only so this
 * module never drags the server-only ClickHouse client into a client island.
 */
import type { TableSummary } from "@/lib/clickhouse/introspect";

/** One table offered in the picker, reduced to what the row draws. */
export interface TableChoice {
  /** "database.name" — the stable key and exactly what a scope stores. */
  id: string;
  database: string;
  name: string;
  engine: string;
  rows: number | null;
  bytes: number | null;
  comment: string;
  /** Pre-formatted so the client never re-derives it. "43.3M rows" | "—". */
  rowsLabel: string;
  /** "1.2 GB", or "" when the engine tracks no size (e.g. a view). */
  sizeLabel: string;
}

/**
 * The scope the human hands the agent: the tables to explore together, plus an
 * optional plain-language focus. `focus` is a nudge, not a query — the board is
 * still nominated by the data, the focus only tilts what gets surfaced first.
 */
export interface ExplorationScope {
  /** One or more "database.name" ids. One table is a valid exploration too. */
  tables: string[];
  /** Optional free text, e.g. "anything about pickup zones". */
  focus?: string;
}

/** Big counts are read at a glance, not audited — 43.3M beats 43,276,150. */
function compactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString("en-US");
}

/** Bytes → a human size. Null (engines that don't track it) becomes "". */
function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A `system.tables` summary → a pickable choice. Total: never throws. */
export function toTableChoice(table: TableSummary): TableChoice {
  return {
    id: `${table.database}.${table.name}`,
    database: table.database,
    name: table.name,
    engine: table.engine,
    rows: table.rows,
    bytes: table.bytes,
    comment: table.comment,
    rowsLabel: table.rows === null ? "—" : `${compactCount(table.rows)} rows`,
    sizeLabel: formatBytes(table.bytes),
  };
}

/**
 * Biggest first: the tables an analyst reaches for are the fact tables, and the
 * fact table is the one with the rows. Null row counts (views) sink to the
 * bottom but keep the introspection order among themselves.
 */
export function byRowsDesc(a: TableChoice, b: TableChoice): number {
  return (b.rows ?? 0) - (a.rows ?? 0);
}

/** Case-insensitive substring match over the fields a person would search. */
export function matchesQuery(choice: TableChoice, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    choice.name.toLowerCase().includes(q) ||
    choice.database.toLowerCase().includes(q) ||
    choice.comment.toLowerCase().includes(q)
  );
}

/** The CTA's words scale with intent: one table explores, many correlate. */
export function ctaLabel(count: number): string {
  if (count === 0) return "Pick a table to begin";
  if (count === 1) return "Explore this table →";
  return `Find connections across ${count} tables →`;
}

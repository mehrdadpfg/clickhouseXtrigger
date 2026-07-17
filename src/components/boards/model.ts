/**
 * The Boards view model.
 *
 * Two jobs, both of which have to survive an arbitrary dataset:
 *
 * 1. Reading `board_tiles.spec`. That column is jsonb — an open bag written by
 *    the agent, by a migration, or by hand. Nothing here may assume a key is
 *    present or a value has the type it should. Every read below is a total
 *    function: bad input degrades to "not specified", never to a throw.
 *
 * 2. Shaping a tile's result rows into props for components/ui. A tile stores
 *    SQL; what comes back is `Record<string, unknown>[]` with column names the
 *    analyst chose. So the shaping *infers* — which column is the value, which
 *    is the axis — and the spec only overrides. That inference is the whole
 *    reason a board can be pointed at any table: nothing here knows a column
 *    name, a unit, or what is being measured.
 *
 * No React, no db. Plain data in, plain data out — this crosses into client
 * islands, so it holds nothing that must not.
 */
import type { StatDirection, StatSentiment } from "@/components/ui/StatTile";
import type { ChartKind, ChartPoint, ChartSeries } from "@/components/ui/Chart";
import type { BoardTileKind, BoardTileRow, BoardTileSpec } from "@/types/db";

// --- rows ------------------------------------------------------------------

/** A row of a tile's result. Column names are the analyst's, never ours. */
export type ResultRow = Record<string, unknown>;

/** What a tile's server action hands back. */
export type TileResult =
  | { ok: true; rows: ResultRow[] }
  | { ok: false; error: string };

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? object : { data: T }))
  | { ok: false; error: string };

// --- the sidebar and the board ---------------------------------------------

/** One row in the boards list. Already reduced to what the sidebar draws. */
export interface BoardListItem {
  id: string;
  title: string;
  tileCount: number;
  /** Pre-formatted server-side, so a browser clock cannot disagree with it. */
  timeLabel: string;
  isoTime: string;
}

/** A board offered in the modal's picker. */
export interface BoardOption {
  id: string;
  title: string;
  tileCount: number;
}

/** A tile, spec parsed, ready to cross into a client island. */
export interface TileView {
  id: string;
  kind: BoardTileKind;
  title: string;
  spec: TileSpec;
  /** Grid columns out of GRID_COLUMNS this tile occupies. */
  span: number;
}

export interface BoardView {
  id: string;
  title: string;
  tiles: TileView[];
}

/** The board grid, from the design: four columns of equal width. */
export const GRID_COLUMNS = 4;

// --- the spec --------------------------------------------------------------

/**
 * A KPI tile: one number out of the first row.
 *
 * Every field is an override. With an empty spec the tile still renders — the
 * first numeric column of the first row is the number, and that is usually
 * exactly right for SQL written to answer one question.
 */
export interface KpiSpec {
  /** Column holding the number. Default: the first numeric column. */
  valueColumn?: string;
  /** Column holding a percentage change. Rendered as the delta. */
  deltaColumn?: string;
  /** '$' prefixes, '%' suffixes, anything else is ignored. */
  unit?: string;
  /** Trailing context on the delta, e.g. "vs Jun". */
  note?: string;
  /**
   * Whether a rising number is good news. The tile cannot know — trips up is
   * good, p99 up is not — so the spec says, and the default is the design's
   * reading rather than a law.
   */
  upIsGood?: boolean;
}

export interface ChartTileSpec {
  /** Default: line over a numeric x, bar over categories. */
  kind?: ChartKind;
  /** Default: the first non-numeric column, else the first column. */
  xColumn?: string;
  /** Default: the first numeric column that isn't x. */
  yColumn?: string;
  /** Splits rows into one series per distinct value. Default: a single series. */
  seriesColumn?: string;
  xLabel?: string;
  yLabel?: string;
  /** Formats the y axis and the tooltip. See formatMetric. */
  unit?: string;

  /**
   * A flint chart spec, present on tiles pinned from a chat answer. When set,
   * the tile renders through flint/ECharts (the chat's engine, 30+ types); when
   * absent, the legacy kind/x/y fields above drive the inline chart.
   */
  chartType?: string;
  encodings?: Record<string, string>;
  horizontal?: boolean;
  semanticTypes?: Record<string, string>;
}

export interface TableTileSpec {
  /** Columns to show, in order. Default: every column, as returned. */
  columns?: string[];
  /** Default: TABLE_ROW_CAP. */
  maxRows?: number;
}

export type TileSpec = {
  /** 1..GRID_COLUMNS. Defaults per kind — see DEFAULT_SPAN. */
  span?: number;
} & KpiSpec &
  ChartTileSpec &
  TableTileSpec;

const CHART_KINDS: readonly ChartKind[] = [
  "line",
  "area",
  "bar",
  "barh",
  "scatter",
];

/** A KPI is a number in a corner; a chart or a table needs room to be read. */
const DEFAULT_SPAN: Record<BoardTileKind, number> = {
  kpi: 1,
  chart: 2,
  table: 2,
};

const TABLE_ROW_CAP = 100;

// --- reading the spec ------------------------------------------------------
//
// jsonb is whatever was written into it. These readers each answer "is this key
// a usable X?" and return undefined when it isn't, so a hand-edited row can
// never do worse than fall back to the inferred default.

function readString(bag: BoardTileSpec, key: string): string | undefined {
  const raw = bag[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readBoolean(bag: BoardTileSpec, key: string): boolean | undefined {
  const raw = bag[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function readInt(
  bag: BoardTileSpec,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = bag[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const rounded = Math.round(raw);
  return rounded < min || rounded > max ? undefined : rounded;
}

function readStringArray(bag: BoardTileSpec, key: string): string[] | undefined {
  const raw = bag[key];
  if (!Array.isArray(raw)) return undefined;
  const strings = raw.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  return strings.length > 0 ? strings : undefined;
}

function readChartKind(bag: BoardTileSpec, key: string): ChartKind | undefined {
  const raw = readString(bag, key);
  return raw && (CHART_KINDS as readonly string[]).includes(raw)
    ? (raw as ChartKind)
    : undefined;
}

/** A jsonb object whose string values are kept — {channel: field} maps. */
function readStringMap(
  bag: BoardTileSpec,
  key: string,
): Record<string, string> | undefined {
  const raw = bag[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** jsonb -> the typed spec. Unknown keys are dropped; bad values fall back. */
export function readSpec(bag: BoardTileSpec | null | undefined): TileSpec {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return {};

  return stripUndefined({
    span: readInt(bag, "span", 1, GRID_COLUMNS),
    valueColumn: readString(bag, "valueColumn"),
    deltaColumn: readString(bag, "deltaColumn"),
    unit: readString(bag, "unit"),
    note: readString(bag, "note"),
    upIsGood: readBoolean(bag, "upIsGood"),
    kind: readChartKind(bag, "kind"),
    xColumn: readString(bag, "xColumn"),
    yColumn: readString(bag, "yColumn"),
    seriesColumn: readString(bag, "seriesColumn"),
    xLabel: readString(bag, "xLabel"),
    yLabel: readString(bag, "yLabel"),
    columns: readStringArray(bag, "columns"),
    maxRows: readInt(bag, "maxRows", 1, TABLE_ROW_CAP),
    // Flint spec (pinned charts): keep these so the tile renders via ECharts.
    chartType: readString(bag, "chartType"),
    encodings: readStringMap(bag, "encodings"),
    horizontal: readBoolean(bag, "horizontal"),
    semanticTypes: readStringMap(bag, "semanticTypes"),
  });
}

/** Keeps `spec` free of explicit undefineds — it crosses the RSC boundary. */
function stripUndefined(spec: TileSpec): TileSpec {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (value !== undefined) out[key] = value;
  }
  return out as TileSpec;
}

export function toTileView(row: BoardTileRow): TileView {
  const spec = readSpec(row.spec);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    spec,
    span: Math.min(spec.span ?? DEFAULT_SPAN[row.kind] ?? 2, GRID_COLUMNS),
  };
}

// --- numbers ---------------------------------------------------------------

/**
 * A cell's number, or null.
 *
 * Both number and string are accepted: ClickHouse hands Int64 and Decimal back
 * as JSON numbers under this server's settings, but that is
 * output_format_json_quote_64bit_integers — a setting, not a guarantee. Quote
 * them and every value arrives as a string.
 *
 * The null and empty-string guards are load-bearing, not defensive habit:
 * `Number(null)` and `Number("")` are both 0, so without them a tile that
 * measured nothing would render a confident zero.
 */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Big numbers are read at a glance, not audited — 3.42M beats 3,417,882. */
function compact(value: number): string | null {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return null;
}

/**
 * The tile's headline number.
 *
 * `unit` is a display hint from the spec, not a currency system: '$' leads the
 * number, '%' trails it, and anything else is dropped rather than guessed at.
 * A unit the tile does not understand must not become a suffix nobody meant.
 */
export function formatMetric(value: number, unit?: string): string {
  if (unit === "%") return `${value.toFixed(1)}%`;

  const short = compact(value);
  if (unit === "$") return `$${short ?? value.toFixed(2)}`;
  if (short) return short;

  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toFixed(2);
}

/** A delta is always a percentage — the sign is carried by the arrow. */
export function formatDelta(value: number): string {
  return `${Math.abs(value).toFixed(1)}%`;
}

function directionOf(value: number): StatDirection {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "flat";
}

/**
 * StatTile keeps direction and sentiment apart on purpose, and this is where
 * that choice gets paid off: `upIsGood` comes from the spec, so a latency board
 * can render a rise in red without the primitive learning what latency is.
 */
function sentimentOf(direction: StatDirection, upIsGood: boolean): StatSentiment {
  if (direction === "flat") return "neutral";
  const good = direction === "up" ? upIsGood : !upIsGood;
  return good ? "good" : "bad";
}

// --- columns ---------------------------------------------------------------

/**
 * The result's columns, in the order the SELECT listed them.
 *
 * Taken from the first row: JSONEachRow gives an object per row and object key
 * order preserves the projection. A later row cannot introduce a column, so one
 * row is the whole schema.
 */
export function columnsOf(rows: ResultRow[]): string[] {
  const first = rows[0];
  return first ? Object.keys(first) : [];
}

/** True when the column reads as a number in the first row that has a value. */
function isNumericColumn(rows: ResultRow[], column: string): boolean {
  for (const row of rows) {
    const raw = row[column];
    if (raw === null || raw === undefined || raw === "") continue;
    return toNumber(raw) !== null;
  }
  return false;
}

/** Honours the spec only when the column actually came back. */
function pick(
  columns: string[],
  requested: string | undefined,
): string | undefined {
  return requested && columns.includes(requested) ? requested : undefined;
}

// --- KPI -------------------------------------------------------------------

export interface KpiView {
  label: string;
  value: string;
  delta?: {
    value: string;
    direction: StatDirection;
    sentiment: StatSentiment;
    note?: string;
  };
}

/**
 * Rows -> StatTile props, or null when the SQL did not produce a number.
 *
 * Null is not an error state to be papered over with a zero: "no rows" and "the
 * value is 0" are different facts, and only one of them is a measurement.
 */
export function toKpi(
  rows: ResultRow[],
  spec: TileSpec,
  title: string,
): KpiView | null {
  const first = rows[0];
  if (!first) return null;

  const columns = Object.keys(first);
  const valueColumn =
    pick(columns, spec.valueColumn) ??
    columns.find((column) => toNumber(first[column]) !== null);
  if (!valueColumn) return null;

  const value = toNumber(first[valueColumn]);
  if (value === null) return null;

  const deltaColumn = pick(columns, spec.deltaColumn);
  const deltaValue = deltaColumn ? toNumber(first[deltaColumn]) : null;

  const view: KpiView = {
    label: title,
    value: formatMetric(value, spec.unit),
  };

  if (deltaValue !== null) {
    const direction = directionOf(deltaValue);
    view.delta = {
      value: formatDelta(deltaValue),
      direction,
      sentiment: sentimentOf(direction, spec.upIsGood ?? true),
      ...(spec.note ? { note: spec.note } : {}),
    };
  }

  return view;
}

// --- chart -----------------------------------------------------------------

export interface ChartView {
  kind: ChartKind;
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  unit?: string;
}

/**
 * Rows -> Chart props, or null when there is nothing plottable.
 *
 * The axes are inferred, because the columns are the analyst's: the category
 * (or time) column is whatever is not a number, the measure is the first column
 * that is. The spec overrides both, but is never required — a board built by
 * pinning a chart out of a thread arrives with no spec at all.
 */
export function toChart(rows: ResultRow[], spec: TileSpec): ChartView | null {
  if (rows.length === 0) return null;

  const columns = columnsOf(rows);
  if (columns.length === 0) return null;

  const numeric = new Set(columns.filter((c) => isNumericColumn(rows, c)));

  const xColumn =
    pick(columns, spec.xColumn) ??
    columns.find((c) => !numeric.has(c)) ??
    columns[0];
  if (!xColumn) return null;

  const yColumn =
    pick(columns, spec.yColumn) ?? columns.find((c) => c !== xColumn && numeric.has(c));
  if (!yColumn) return null;

  const seriesColumn = (() => {
    const requested = pick(columns, spec.seriesColumn);
    return requested && requested !== xColumn && requested !== yColumn
      ? requested
      : undefined;
  })();

  const xIsNumeric = numeric.has(xColumn);
  const toX = (raw: unknown) =>
    xIsNumeric ? (toNumber(raw) ?? 0) : String(raw ?? "—");

  // Insertion-ordered: the first appearance of a series fixes its palette slot,
  // so colour follows the entity and re-sorting the SQL never repaints it.
  const grouped = new Map<string, ChartPoint[]>();
  const soleName = spec.yLabel ?? yColumn;

  for (const row of rows) {
    const name = seriesColumn ? String(row[seriesColumn] ?? "—") : soleName;
    let points = grouped.get(name);
    if (!points) {
      points = [];
      grouped.set(name, points);
    }
    // null is a gap, not a zero — toNumber already draws that line.
    points.push({ x: toX(row[xColumn]), y: toNumber(row[yColumn]) });
  }

  const series: ChartSeries[] = [...grouped.entries()].map(
    ([name, points], index) => ({ name, points, colorSlot: index }),
  );
  if (series.length === 0) return null;

  return {
    // An explicit kind wins. Otherwise: a numeric x is a progression and reads
    // as a line; anything else is a set of categories and reads as bars. Chart
    // turns bars on their side by itself when the labels need it.
    kind: spec.kind ?? (xIsNumeric ? "line" : "bar"),
    series,
    // The axis labels default to the column names — the analyst's own words,
    // which is the closest thing to a label this layer can honestly produce.
    xLabel: spec.xLabel ?? xColumn,
    yLabel: spec.yLabel ?? yColumn,
    ...(spec.unit ? { unit: spec.unit } : {}),
  };
}

// --- table -----------------------------------------------------------------

export interface TableView {
  columns: string[];
  rows: ResultRow[];
  /** Rows the SQL returned, before the cap. */
  total: number;
}

/** Rows -> DataTable props. Columns come from the result, never from a schema. */
export function toTable(rows: ResultRow[], spec: TileSpec): TableView {
  const available = columnsOf(rows);
  const requested = spec.columns?.filter((c) => available.includes(c));
  const columns = requested && requested.length > 0 ? requested : available;

  const cap = spec.maxRows ?? TABLE_ROW_CAP;
  return { columns, rows: rows.slice(0, cap), total: rows.length };
}

/**
 * A cell, as text. Numbers get the same compaction as a KPI so a column of
 * figures is readable; everything else is shown as it arrived.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return formatMetric(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// --- actions ---------------------------------------------------------------

/** The board a tile is being added to: one that exists, or one to mint. */
export type TileTarget =
  | { kind: "existing"; boardId: string }
  | { kind: "new"; title: string };

export interface TileDraft {
  target: TileTarget;
  kind: BoardTileKind;
  title: string;
  sql: string;
  /** Display hint for kpi/chart tiles. See formatMetric. */
  unit?: string;
}

export const TILE_KINDS: readonly { value: BoardTileKind; label: string }[] = [
  { value: "kpi", label: "KPI" },
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
];

/** The units formatMetric understands. "" means the number stands alone. */
export const TILE_UNITS: readonly { value: string; label: string }[] = [
  { value: "", label: "plain" },
  { value: "$", label: "$" },
  { value: "%", label: "%" },
];

/**
 * The Boards screen's writes. Handed to the components as props by the route,
 * so nothing under components/ imports lib/db.
 */
export interface BoardActions {
  /** Runs a tile's *stored* SQL. Takes an id — never SQL from the browser. */
  run: (tileId: string) => Promise<TileResult>;
  createBoard: (title: string) => Promise<ActionResult<{ id: string }>>;
  addTile: (draft: TileDraft) => Promise<ActionResult>;
  removeTile: (tileId: string) => Promise<ActionResult>;
}

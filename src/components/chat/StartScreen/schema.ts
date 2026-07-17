import type { ColumnInfo } from "@/lib/clickhouse/introspect";

/**
 * Turns an introspected schema into the two things the Start screen shows:
 * the "what's in the data" chips, and four starter questions.
 *
 * Pure — no I/O, no React, no server-only imports (the ColumnInfo import is
 * type-only, so it is erased at build). The route does the introspection and
 * hands the result here, which keeps this testable and keeps the screen honest:
 * nothing below is written for nyc_taxi, or for any other table.
 */

/** How many column chips fit the design's hint box before "+N more". */
export const MAX_CHIPS = 7;

export type ColumnKind =
  | "datetime"
  | "date"
  | "categorical"
  | "numeric"
  | "boolean"
  | "other";

export type SchemaChip = {
  name: string;
  /** Short label shown in the chip: "float", "enum", "datetime". */
  label: string;
  /** The full ClickHouse type, e.g. Nullable(Float32). Shown on hover. */
  type: string;
};

export type Dataset = {
  /** Qualified name, e.g. "default.nyc_taxi". */
  table: string;
  /** Unqualified name — reads better in prose than the qualified one. */
  shortName: string;
  /** Null for engines that don't track one (views). */
  rows: number | null;
  columnCount: number;
  chips: SchemaChip[];
  /** Columns beyond MAX_CHIPS — the "+N more" count. */
  overflow: number;
};

export type Starter = {
  question: string;
  /** The design's sub-label: "ranking · bar chart". */
  hint: string;
  /** The fourth starter subscribes to a question instead of just asking it. */
  watcher?: boolean;
};

/**
 * Strips the wrappers that don't change how a column reads to an analyst.
 * Nullable(LowCardinality(String)) is, for our purposes, a String.
 */
function unwrap(type: string): string {
  let t = type.trim();
  for (;;) {
    const m = /^(?:Nullable|LowCardinality)\((.*)\)$/s.exec(t);
    if (!m?.[1]) return t;
    t = m[1].trim();
  }
}

/** The base type without its parameters: Decimal(10, 2) -> Decimal. */
function baseOf(type: string): string {
  return /^([A-Za-z_0-9]+)/.exec(unwrap(type))?.[1] ?? unwrap(type);
}

export function kindOf(type: string): ColumnKind {
  const base = baseOf(type);

  if (base === "DateTime" || base === "DateTime64") return "datetime";
  if (base === "Date" || base === "Date32") return "date";
  if (base === "Bool" || base === "Boolean") return "boolean";
  if (base === "Enum" || base === "Enum8" || base === "Enum16") {
    return "categorical";
  }
  if (base === "String" || base === "FixedString") return "categorical";
  if (/^(?:U?Int(?:8|16|32|64|128|256)|Float32|Float64|Decimal\d*)$/.test(base)) {
    return "numeric";
  }
  return "other";
}

/** The short type label in the design's chips ("float", "str", "enum"). */
export function typeLabel(type: string): string {
  const base = baseOf(type);

  const exact: Record<string, string> = {
    DateTime: "datetime",
    DateTime64: "datetime",
    Date: "date",
    Date32: "date",
    Bool: "bool",
    Boolean: "bool",
    Enum: "enum",
    Enum8: "enum",
    Enum16: "enum",
    String: "str",
    FixedString: "str",
    UUID: "uuid",
    Float32: "float",
    Float64: "float",
    IPv4: "ip",
    IPv6: "ip",
    Array: "array",
    Map: "map",
    Tuple: "tuple",
    JSON: "json",
  };

  if (exact[base]) return exact[base];
  if (/^Decimal/.test(base)) return "decimal";
  if (/^U?Int/.test(base)) return "int";
  return base.toLowerCase();
}

/**
 * Columns whose *name* says they identify a row rather than measure it.
 * Averaging trip_id is a real number and a meaningless question, so these are
 * kept out of starter questions (they stay in the schema chips — they are part
 * of the data, just not an interesting thing to aggregate).
 */
function isIdentifierName(name: string): boolean {
  const n = name.toLowerCase();
  return n === "id" || n.endsWith("_id") || n.endsWith("_uuid") || n === "uuid";
}

/** Coordinates are numeric but averaging them is nonsense. */
function isCoordinateName(name: string): boolean {
  return /(^|_)(lat|latitude|lon|lng|long|longitude)$/i.test(name);
}

type Shape = {
  time?: ColumnInfo;
  categorical?: ColumnInfo;
  measures: ColumnInfo[];
};

/**
 * Picks the columns a starter question can reasonably lean on.
 *
 * The preferences encode what tends to make a good question, not what a
 * particular dataset holds: an enum or a LowCardinality column groups better
 * than free text; a float measures better than an integer (which is more often
 * a count or a code); the first datetime is usually the event time, since
 * that is what tables get sorted by.
 */
export function readShape(columns: ColumnInfo[]): Shape {
  const time =
    columns.find((c) => kindOf(c.type) === "datetime") ??
    columns.find((c) => kindOf(c.type) === "date");

  // Enum/LowCardinality first — they are declared-small, so they group cleanly.
  const categorical =
    columns.find((c) => /^(?:Nullable\()?(?:Enum|LowCardinality)/.test(c.type)) ??
    columns.find(
      (c) => kindOf(c.type) === "categorical" && !isIdentifierName(c.name),
    );

  const numeric = columns.filter(
    (c) =>
      kindOf(c.type) === "numeric" &&
      !isIdentifierName(c.name) &&
      !isCoordinateName(c.name),
  );

  // Floats before ints: an int column is more often a code or a count.
  const measures = [
    ...numeric.filter((c) => /Float|Decimal/.test(c.type)),
    ...numeric.filter((c) => !/Float|Decimal/.test(c.type)),
  ];

  return { time, categorical, measures };
}

/**
 * Four starters derived from the schema's *shape*.
 *
 * Every branch degrades: with a categorical and a measure we can ask a real
 * ranking question; with neither we fall back to phrasing that assumes nothing
 * about the data beyond it having rows. No branch mentions a domain — the words
 * around the column names are all the domain knowledge there is.
 */
export function deriveStarters(dataset: Dataset, columns: ColumnInfo[]): Starter[] {
  const { time, categorical, measures } = readShape(columns);
  const [measure, second] = measures;
  const table = dataset.shortName;

  // Four questions about the same column read like one question asked badly, so
  // the later starters walk down the measure list where there is one to walk.
  const overTimeMeasure = measures[1] ?? measure;
  const watchMeasure = measures[2] ?? measures[1] ?? measure;

  // 1 — ranking.
  const ranking: Starter =
    categorical && measure
      ? {
          question: `Which ${categorical.name} has the highest average ${measure.name}?`,
          hint: "ranking · bar chart",
        }
      : categorical
        ? {
            question: `Which ${categorical.name} appears most often?`,
            hint: "ranking · bar chart",
          }
        : measure
          ? {
              question: `What are the highest values of ${measure.name}?`,
              hint: "ranking · bar chart",
            }
          : {
              question: `What are the most common values in ${table}?`,
              hint: "ranking · bar chart",
            };

  // 2 — relationship.
  const relationship: Starter =
    measure && second
      ? {
          question: `How does ${measure.name} scale with ${second.name}?`,
          hint: "relationship · scatter",
        }
      : measure
        ? {
            question: `How is ${measure.name} distributed?`,
            hint: "distribution · histogram",
          }
        : {
            question: `Which columns in ${table} move together?`,
            hint: "relationship · scatter",
          };

  // 3 — over time. Needs a time column; without one, describe the table instead.
  const overTime: Starter = time
    ? overTimeMeasure
      ? {
          question: `How has average ${overTimeMeasure.name} changed over time?`,
          hint: "over time · line",
        }
      : {
          question: `How many rows per hour, by ${time.name}?`,
          hint: "over time · line",
        }
    : categorical
      ? {
          question: `Break ${table} down by ${categorical.name}`,
          hint: "breakdown · bar chart",
        }
      : {
          question: `What does a typical row in ${table} look like?`,
          hint: "sample · table",
        };

  // 4 — the watcher. Always phrased as a standing question, never a one-off.
  const watch: Starter =
    watchMeasure && time
      ? {
          question: `Tell me when average ${watchMeasure.name} drops 20% week over week`,
          hint: "◉ creates a watcher",
          watcher: true,
        }
      : watchMeasure
        ? {
            question: `Tell me when average ${watchMeasure.name} drops 20%`,
            hint: "◉ creates a watcher",
            watcher: true,
          }
        : categorical
          ? {
              question: `Tell me when a new ${categorical.name} shows up`,
              hint: "◉ creates a watcher",
              watcher: true,
            }
          : {
              question: `Tell me when ${table} stops growing`,
              hint: "◉ creates a watcher",
              watcher: true,
            };

  return [ranking, relationship, overTime, watch];
}

/** The connected-dataset pill + schema chips, from one introspected table. */
export function toDataset(
  input: { database: string; name: string; rows: number | null },
  columns: ColumnInfo[],
): Dataset {
  return {
    table: `${input.database}.${input.name}`,
    shortName: input.name,
    rows: input.rows,
    columnCount: columns.length,
    chips: columns.slice(0, MAX_CHIPS).map((c) => ({
      name: c.name,
      label: typeLabel(c.type),
      type: c.type,
    })),
    overflow: Math.max(0, columns.length - MAX_CHIPS),
  };
}

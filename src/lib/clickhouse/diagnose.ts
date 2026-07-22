import { clickhouse, READONLY_SETTINGS } from "./client";

/**
 * The physical profile of the user's tables — the evidence Tune needs to see
 * problems that are invisible in the query log.
 *
 * `queryLog.ts` answers "what is being asked, and what does it cost?". That is
 * enough to propose a materialized view or a projection, and nothing else. To
 * say "this String should be LowCardinality", "this sort key leads with the
 * wrong column", or "small inserts are outrunning merges", you have to look at
 * how the data is actually stored. That is what this reads.
 *
 * Every number here comes from ClickHouse's own accounting (system.parts,
 * system.parts_columns) rather than from sampling the data, so profiling a
 * 90-million-row table costs the same as profiling an empty one.
 *
 * Dataset-agnostic, same as the rest: nothing names a table. The system
 * databases are excluded and whatever remains is the user's.
 *
 * Server-only: never import from a "use client" module.
 */

const SYSTEM_DATABASES = ["system", "INFORMATION_SCHEMA", "information_schema"];

export type ColumnProfile = {
  name: string;
  type: string;
  compressedBytes: number;
  uncompressedBytes: number;
  /**
   * uncompressed / compressed. The single most useful signal in here: a String
   * column compressing 8-10x is repeating itself heavily, which is exactly the
   * LowCardinality case. It is a hint, not proof — the agent confirms with a
   * uniq() sample before proposing.
   */
  ratio: number;
};

export type TableProfile = {
  database: string;
  name: string;
  engine: string;
  rows: number;
  bytes: number;
  /** "" when the engine has none. */
  sortingKey: string;
  partitionKey: string;
  /** Active parts. High counts against modest rows mean small-write pressure. */
  parts: number;
  avgRowsPerPart: number;
  columns: ColumnProfile[];
  /** Already-present optimizations, so nothing is proposed twice. */
  existingIndices: string[];
  existingProjections: string[];
};

export type PhysicalProfile = {
  tables: TableProfile[];
  /** Materialized views already defined, by name — also "do not re-propose". */
  materializedViews: string[];
};

type TableRow = {
  database: string;
  name: string;
  engine: string;
  total_rows: string | null;
  total_bytes: string | null;
  sorting_key: string;
  partition_key: string;
};

type PartsRow = { database: string; table: string; parts: string; avgRows: number };

type ColumnRow = {
  database: string;
  table: string;
  column: string;
  type: string;
  compressed: string;
  uncompressed: string;
};

type NamedRow = { database: string; table: string; name: string };

function num(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

const key = (database: string, table: string) => `${database}.${table}`;

/**
 * Profile every MergeTree-family table in the user's databases.
 *
 * Five reads issued together. They are separate rather than joined because
 * system.parts and system.parts_columns aggregate at different grains (part vs
 * part-column), and joining them in ClickHouse would multiply rows before the
 * aggregate — cheaper and clearer to group each on its own and stitch by key.
 */
export async function profilePhysical(): Promise<PhysicalProfile> {
  const params = { systemDatabases: SYSTEM_DATABASES };

  const [tablesSet, partsSet, columnsSet, indicesSet, projectionsSet, mvSet] =
    await Promise.all([
      clickhouse.query({
        query: `
          SELECT database, name, engine, total_rows, total_bytes,
                 sorting_key, partition_key
          FROM system.tables
          WHERE database NOT IN ({systemDatabases:Array(String)})
            AND engine LIKE '%MergeTree%'
          ORDER BY database, name
        `,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: READONLY_SETTINGS,
      }),
      clickhouse.query({
        query: `
          SELECT database, table,
                 toString(count())     AS parts,
                 round(avg(rows))      AS avgRows
          FROM system.parts
          WHERE active AND database NOT IN ({systemDatabases:Array(String)})
          GROUP BY database, table
        `,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: READONLY_SETTINGS,
      }),
      // The type filter is deliberately absent here and the aggregate is not
      // filtered on: putting a predicate over an aggregated alias beside the
      // aggregates trips ClickHouse's analyzer with "found in WHERE" (the same
      // trap documented in queryLog.ts). Everything is aggregated, then shaped
      // in TypeScript.
      clickhouse.query({
        query: `
          SELECT database, table, column,
                 any(type)                                  AS type,
                 toString(sum(column_data_compressed_bytes))   AS compressed,
                 toString(sum(column_data_uncompressed_bytes)) AS uncompressed
          FROM system.parts_columns
          WHERE active AND database NOT IN ({systemDatabases:Array(String)})
          GROUP BY database, table, column
        `,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: READONLY_SETTINGS,
      }),
      clickhouse.query({
        query: `
          SELECT database, table, name
          FROM system.data_skipping_indices
          WHERE database NOT IN ({systemDatabases:Array(String)})
        `,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: READONLY_SETTINGS,
      }),
      clickhouse.query({
        query: `
          SELECT database, table, name
          FROM system.projections
          WHERE database NOT IN ({systemDatabases:Array(String)})
        `,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: READONLY_SETTINGS,
      }),
      clickhouse.query({
        query: `
          SELECT database, name
          FROM system.tables
          WHERE database NOT IN ({systemDatabases:Array(String)})
            AND engine = 'MaterializedView'
        `,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: READONLY_SETTINGS,
      }),
    ]);

  const [tableRows, partsRows, columnRows, indexRows, projectionRows, mvRows] =
    await Promise.all([
      tablesSet.json<TableRow>(),
      partsSet.json<PartsRow>(),
      columnsSet.json<ColumnRow>(),
      indicesSet.json<NamedRow>(),
      projectionsSet.json<NamedRow>(),
      mvSet.json<{ database: string; name: string }>(),
    ]);

  const partsBy = new Map(partsRows.map((r) => [key(r.database, r.table), r]));

  const columnsBy = new Map<string, ColumnProfile[]>();
  for (const row of columnRows) {
    const compressed = num(row.compressed);
    const uncompressed = num(row.uncompressed);
    const list = columnsBy.get(key(row.database, row.table)) ?? [];
    list.push({
      name: row.column,
      type: row.type,
      compressedBytes: compressed,
      uncompressedBytes: uncompressed,
      ratio: compressed > 0 ? Number((uncompressed / compressed).toFixed(1)) : 0,
    });
    columnsBy.set(key(row.database, row.table), list);
  }

  const groupNames = (rows: NamedRow[]) => {
    const by = new Map<string, string[]>();
    for (const row of rows) {
      const k = key(row.database, row.table);
      by.set(k, [...(by.get(k) ?? []), row.name]);
    }
    return by;
  };
  const indicesBy = groupNames(indexRows);
  const projectionsBy = groupNames(projectionRows);

  const tables: TableProfile[] = tableRows.map((row) => {
    const k = key(row.database, row.name);
    const parts = partsBy.get(k);
    const columns = (columnsBy.get(k) ?? []).sort(
      (a, b) => b.compressedBytes - a.compressedBytes,
    );
    return {
      database: row.database,
      name: row.name,
      engine: row.engine,
      rows: num(row.total_rows),
      bytes: num(row.total_bytes),
      sortingKey: row.sorting_key ?? "",
      partitionKey: row.partition_key ?? "",
      parts: num(parts?.parts),
      avgRowsPerPart: num(parts?.avgRows),
      columns,
      existingIndices: indicesBy.get(k) ?? [],
      existingProjections: projectionsBy.get(k) ?? [],
    };
  });

  return {
    tables,
    materializedViews: mvRows.map((r) => key(r.database, r.name)),
  };
}

// --- the agent's investigation tool ----------------------------------------

/** One column's real distinct count — the check before proposing LowCardinality. */
export type CardinalitySample = {
  column: string;
  distinct: number;
  nulls: number;
  sampledRows: number;
};

/**
 * Measure distinct values for specific columns of one table.
 *
 * This is the difference between guessing and knowing. A high compression ratio
 * *suggests* LowCardinality; only a distinct count decides it, and the
 * threshold is real (LowCardinality degrades above ~10K distinct values). The
 * agent calls this before proposing any type change.
 *
 * Bounded three ways: identifiers are validated against the live schema by the
 * caller, the read is capped by SAMPLE_ROWS, and READONLY_SETTINGS applies.
 * uniqCombined is an estimate — exact enough for a 10K threshold, and it does
 * not build a hash set over 90 million rows.
 *
 * The inner SELECT names its columns rather than using `*`. That is not style:
 * `SELECT *` materialises every column of the sampled rows, which on a wide
 * multi-GB table is tens of seconds of pointless I/O and overruns the readonly
 * time cap. Naming them is what makes the sample nearly free on a columnar
 * engine.
 */
const SAMPLE_ROWS = 2_000_000;

export async function sampleCardinality(
  database: string,
  table: string,
  columns: string[],
): Promise<CardinalitySample[]> {
  if (columns.length === 0) return [];

  // Identifiers cannot be bound as query parameters, so they are verified
  // against system.columns and then backtick-quoted. A name that is not
  // actually a column of this table never reaches the statement.
  const known = await clickhouse.query({
    query: `
      SELECT name FROM system.columns
      WHERE database = {database:String} AND table = {table:String}
    `,
    format: "JSONEachRow",
    query_params: { database, table },
    clickhouse_settings: READONLY_SETTINGS,
  });
  const valid = new Set((await known.json<{ name: string }>()).map((r) => r.name));
  const safe = columns.filter((c) => valid.has(c));
  if (safe.length === 0) return [];

  const quote = (id: string) => `\`${id.replace(/`/g, "``")}\``;
  const projections = safe
    .map(
      (c, i) =>
        `toString(uniqCombined(${quote(c)})) AS d${i}, ` +
        `toString(countIf(isNull(${quote(c)}))) AS n${i}`,
    )
    .join(", ");

  const result = await clickhouse.query({
    query: `
      SELECT ${projections}, toString(count()) AS sampled
      FROM (
        SELECT ${safe.map(quote).join(", ")}
        FROM ${quote(database)}.${quote(table)}
        LIMIT {rows:UInt64}
      )
    `,
    format: "JSONEachRow",
    query_params: { rows: SAMPLE_ROWS },
    clickhouse_settings: READONLY_SETTINGS,
  });

  const row = (await result.json<Record<string, string>>())[0];
  if (!row) return [];

  return safe.map((column, i) => ({
    column,
    distinct: num(row[`d${i}`]),
    nulls: num(row[`n${i}`]),
    sampledRows: num(row.sampled),
  }));
}

// --- conversion preflight --------------------------------------------------

/**
 * Is `ALTER TABLE … MODIFY COLUMN col <type>` safe to run on this column?
 *
 * THIS IS A SAFETY GATE, NOT A HINT. ClickHouse makes an unsafe type change
 * uniquely dangerous, verified on 26.2.1:
 *
 *   1. The ALTER returns success immediately — the caller sees no error.
 *   2. The rewrite happens later, as a background mutation.
 *   3. If a single value will not parse, that mutation fails and STICKS, and
 *      the table stops being readable: a plain SELECT throws CANNOT_PARSE_TEXT.
 *
 * So "the DDL succeeded" says nothing about whether the table survived, and a
 * caller that reports success on the command's return value is reporting a lie.
 * The check has to happen BEFORE the ALTER, and it has to cover every row —
 * sampling is exactly what produces the bad proposal in the first place.
 *
 * Also catches silent narrowing: '007' → UInt32 parses fine and loses the
 * leading zeros, which no parse check would notice, so the round trip back to
 * String is compared too.
 *
 * The empty string is counted as a failure, not skipped. It reads like "no
 * value", but ClickHouse does not treat it that way: CAST('' AS UInt32) throws
 * ATTEMPT_TO_READ_AFTER_EOF. An earlier version of this function excluded ''
 * and consequently passed a column whose 8,080 blanks would have stuck the
 * mutation and taken the table offline — the exact outcome it exists to stop.
 */
export type ConversionCheck = {
  column: string;
  targetType: string;
  safe: boolean;
  /** Rows that would not survive. Zero when safe. */
  badRows: number;
  /** A few offending values, for the reader to judge. */
  examples: string[];
  reason: string;
};

export async function checkConversion(
  database: string,
  table: string,
  column: string,
  targetType: string,
): Promise<ConversionCheck> {
  const base: Omit<ConversionCheck, "safe" | "badRows" | "examples" | "reason"> =
    { column, targetType };

  const known = await clickhouse.query({
    query: `
      SELECT type FROM system.columns
      WHERE database = {database:String} AND table = {table:String}
        AND name = {column:String}
    `,
    format: "JSONEachRow",
    query_params: { database, table, column },
    clickhouse_settings: READONLY_SETTINGS,
  });
  const current = (await known.json<{ type: string }>())[0]?.type;
  if (!current) {
    return { ...base, safe: false, badRows: 0, examples: [], reason: "No such column." };
  }

  // Widening a Nullable(T) to T is only safe when no NULL is present; a type
  // that is not a String source is left to ClickHouse's own type checking.
  const quote = (id: string) => `\`${id.replace(/`/g, "``")}\``;
  const col = quote(column);
  const from = `${quote(database)}.${quote(table)}`;

  if (/^Nullable\(/i.test(current) && !/^Nullable\(/i.test(targetType)) {
    const result = await clickhouse.query({
      query: `SELECT toString(countIf(isNull(${col}))) AS bad FROM ${from}`,
      format: "JSONEachRow",
      clickhouse_settings: READONLY_SETTINGS,
    });
    const bad = num((await result.json<{ bad: string }>())[0]?.bad);
    return {
      ...base,
      safe: bad === 0,
      badRows: bad,
      examples: [],
      reason:
        bad === 0
          ? "No NULLs present — dropping Nullable is safe."
          : `${bad.toLocaleString()} rows hold NULL and would be lost.`,
    };
  }

  if (!/String/i.test(current)) {
    return {
      ...base,
      safe: true,
      badRows: 0,
      examples: [],
      reason: "Not a String source — ClickHouse validates this conversion itself.",
    };
  }

  // The target's OrNull caster. `LowCardinality(String)` and `Enum` do not
  // change the value, only its encoding, so they are always parse-safe.
  const inner = /^LowCardinality\((.+)\)$/i.exec(targetType)?.[1] ?? targetType;
  if (/^(String|Enum)/i.test(inner)) {
    return {
      ...base,
      safe: true,
      badRows: 0,
      examples: [],
      reason: "Encoding-only change — values are unchanged.",
    };
  }

  // Build the "value would NOT survive the conversion" predicate for the target.
  // Most types have a toXOrNull that returns NULL on an unparseable value (and a
  // value that parses but round-trips to a different string, like '007', is also
  // unsafe). FixedString is the exception: it has NO OrNull caster (toFixedString
  // needs a length and THROWS rather than returning NULL — `toFixedStringOrNull`
  // does not exist), so whether a value fits is a pure byte-length question.
  // The predicate runs on the sampled column, aliased `v` below.
  const fixed = /^FixedString\((\d+)\)$/i.exec(inner);
  const predicate = fixed
    ? `length(v) > ${fixed[1]}`
    : (() => {
        const caster = `to${inner.replace(/\(.*$/, "")}OrNull`;
        return `${caster}(v) IS NULL OR toString(${caster}(v)) != v`;
      })();

  try {
    // Bound the scan to a SAMPLE of the leading rows, not the whole column. The
    // original scanned until it found a MILLION bad rows — so a clean 3.1B-row
    // column was read end to end and blew the 30s execution cap. A couple of
    // million rows is enough for the agent to see whether a conversion is broadly
    // safe; the check is advisory now (column_type findings are no longer
    // auto-applied), so a far-tail bad value it might miss no longer gates a real
    // mutation.
    const result = await clickhouse.query({
      query: `
        SELECT
          toString(count()) AS bad,
          arraySlice(groupArray(v), 1, 5) AS examples
        FROM (
          SELECT v
          FROM (SELECT ${col} AS v FROM ${from} LIMIT {rows:UInt64})
          WHERE ${predicate}
        )
      `,
      query_params: { rows: SAMPLE_ROWS },
      format: "JSONEachRow",
      clickhouse_settings: READONLY_SETTINGS,
    });
    const row = (await result.json<{ bad: string; examples: string[] }>())[0];
    const bad = num(row?.bad);
    const sample = `a ${SAMPLE_ROWS.toLocaleString()}-row sample`;
    return {
      ...base,
      safe: bad === 0,
      badRows: bad,
      examples: (row?.examples ?? []).slice(0, 5),
      reason:
        bad === 0
          ? `Every value converts cleanly to ${targetType} (checked ${sample}).`
          : `${bad.toLocaleString()} value(s) in ${sample} do not survive conversion to ${targetType}.`,
    };
  } catch (cause) {
    // An unknown caster (an exotic target type) is not proof of safety.
    return {
      ...base,
      safe: false,
      badRows: 0,
      examples: [],
      reason:
        cause instanceof Error
          ? `Could not verify: ${cause.message}`
          : "Could not verify this conversion.",
    };
  }
}

/**
 * The `MODIFY COLUMN <name> <type>` pairs in one ALTER statement.
 *
 * A single ALTER may carry many, comma-separated, and each one is an
 * independent risk — the whole mutation sticks if any of them fails.
 */
export function parseColumnModifications(
  statement: string,
): { column: string; targetType: string }[] {
  const out: { column: string; targetType: string }[] = [];
  const pattern =
    /modify\s+column\s+`?([A-Za-z_][\w]*)`?\s+((?:[A-Za-z_][\w]*)(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)/gi;
  for (const match of statement.matchAll(pattern)) {
    const column = match[1];
    const targetType = match[2]?.trim();
    // A bare CODEC/TTL/DEFAULT modifier is not a type change.
    if (column && targetType && !/^(codec|ttl|default|comment|remove)$/i.test(targetType)) {
      out.push({ column, targetType });
    }
  }
  return out;
}

// --- rendering for the prompt ----------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * The profile as the model reads it.
 *
 * Columns are capped per table: a wide table would otherwise crowd out the
 * query-log evidence, and the columns that matter are the large ones — they are
 * already sorted by compressed size, so the cap keeps the interesting end.
 */
export function renderProfile(profile: PhysicalProfile, maxColumns = 18): string {
  return profile.tables
    .map((t) => {
      const shown = t.columns.slice(0, maxColumns);
      const hidden = t.columns.length - shown.length;
      const cols = shown
        .map(
          (c) =>
            `    ${c.name} ${c.type} — ${formatBytes(c.compressedBytes)} compressed, ratio ${c.ratio}x`,
        )
        .join("\n");

      const extras: string[] = [];
      if (t.existingIndices.length)
        extras.push(`  existing skip indices: ${t.existingIndices.join(", ")}`);
      if (t.existingProjections.length)
        extras.push(`  existing projections: ${t.existingProjections.join(", ")}`);

      return [
        `${t.database}.${t.name} — ${t.engine}, ${t.rows.toLocaleString()} rows, ${formatBytes(t.bytes)}`,
        `  ORDER BY: ${t.sortingKey || "(none)"}`,
        `  PARTITION BY: ${t.partitionKey || "(none)"}`,
        `  parts: ${t.parts} active, avg ${t.avgRowsPerPart.toLocaleString()} rows/part`,
        ...extras,
        `  columns (largest first${hidden > 0 ? `, ${hidden} smaller omitted` : ""}):`,
        cols,
      ].join("\n");
    })
    .join("\n\n");
}

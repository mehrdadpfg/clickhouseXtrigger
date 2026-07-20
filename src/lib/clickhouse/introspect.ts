import { clickhouse } from "./client";

/**
 * Runtime schema introspection over system.tables / system.columns.
 *
 * This is what keeps Vantage dataset-agnostic: no table name, column list or
 * DDL is ever written into a prompt or a component. Whatever the configured
 * ClickHouse holds is what the app can answer questions about.
 *
 * Server-only: never import from a "use client" module.
 */

/** Databases ClickHouse ships with — never part of the user's dataset. */
const SYSTEM_DATABASES = ["system", "INFORMATION_SCHEMA", "information_schema"];

/**
 * Schema changes far more slowly than the agent asks about it — a single turn
 * can call listTables then describeTable several times over. A short TTL
 * collapses that into one round trip while still picking up a DDL change
 * within seconds.
 */
const TTL_MS = 30_000;

export type TableSummary = {
  database: string;
  name: string;
  engine: string;
  /** Null for engines that don't track a row count (e.g. views). */
  rows: number | null;
  /** On-disk compressed size. Null for engines that don't track it. */
  bytes: number | null;
  /** ORDER BY expression, "" when the engine has none. */
  sortingKey: string;
  comment: string;
};

export type ColumnInfo = {
  name: string;
  type: string;
  comment: string;
};

export type TableSchema = TableSummary & { columns: ColumnInfo[] };

type TableRow = {
  database: string;
  name: string;
  engine: string;
  total_rows: string | null;
  total_bytes: string | null;
  sorting_key: string;
  comment: string;
};

type CacheEntry<T> = { value: Promise<T>; expires: number };

/**
 * Per-process TTL memo. Caches the *promise*, so concurrent callers share one
 * in-flight query rather than racing to issue duplicates. A rejected promise is
 * evicted so a transient failure can't be served for the rest of the TTL.
 */
function memo<T>(cache: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = load().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });

  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

const tableCache = new Map<string, CacheEntry<TableSummary[]>>();
const columnCache = new Map<string, CacheEntry<ColumnInfo[]>>();
const namespaceCache = new Map<string, CacheEntry<Record<string, Record<string, string[]>>>>();

/** UInt64 arrives as a string in the JSON formats; absent stays null. */
function toNumber(raw: string | null): number | null {
  return raw === null ? null : Number(raw);
}

function toSummary(row: TableRow): TableSummary {
  return {
    database: row.database,
    name: row.name,
    engine: row.engine,
    rows: toNumber(row.total_rows),
    bytes: toNumber(row.total_bytes),
    sortingKey: row.sorting_key,
    comment: row.comment,
  };
}

async function loadTables(database: string): Promise<TableSummary[]> {
  const resultSet = await clickhouse.query({
    query: `
      SELECT database, name, engine, total_rows, total_bytes, sorting_key, comment
      FROM system.tables
      WHERE database NOT IN ({systemDatabases:Array(String)})
        AND (empty({database:String}) OR database = {database:String})
      ORDER BY database, name
    `,
    format: "JSONEachRow",
    // Bound, never interpolated: the database name reaches ClickHouse as a
    // value, so a model-authored string cannot alter the statement.
    query_params: {
      systemDatabases: SYSTEM_DATABASES,
      database,
    },
  });

  const rows = await resultSet.json<TableRow>();
  return rows.map(toSummary);
}

/**
 * Every queryable table/view, system databases excluded.
 *
 * @param database Restrict to one database. Omit for all user databases.
 */
export function listTables(database?: string): Promise<TableSummary[]> {
  const key = database ?? "";
  return memo(tableCache, key, () => loadTables(key));
}

async function loadColumns(database: string, table: string): Promise<ColumnInfo[]> {
  const resultSet = await clickhouse.query({
    query: `
      SELECT name, type, comment
      FROM system.columns
      WHERE database = {database:String} AND table = {table:String}
      ORDER BY position
    `,
    format: "JSONEachRow",
    query_params: { database, table },
  });

  return await resultSet.json<ColumnInfo>();
}

/**
 * Columns + engine metadata for one table, or null when it doesn't exist.
 *
 * The name is validated against listTables before use — an unknown table is
 * rejected rather than queried, so neither argument can be a vector even if the
 * bound parameters above were ever loosened.
 */
export async function describeTable(
  database: string,
  table: string,
): Promise<TableSchema | null> {
  const summary = (await listTables(database)).find((t) => t.name === table);
  if (!summary) return null;

  const columns = await memo(columnCache, `${database}.${table}`, () =>
    loadColumns(database, table),
  );

  return { ...summary, columns };
}

/**
 * Every column in the scoped databases, nested as { db: { table: ["col", …] } }.
 *
 * Nested, not flat "db.table" keys: CodeMirror resolves `defaultSchema` and
 * `defaultTable` against the namespace structure, so a flat key completes only
 * once the reader has typed the qualifier — which defeats the point.
 *
 * Feeds the query editor's autocomplete. One sweep of system.columns rather
 * than a describeTable per table: the editor wants the whole namespace up front
 * and a table-at-a-time walk would be dozens of round trips before the reader
 * can type. System databases are excluded on the same grounds as listTables —
 * they are noise in a completion list.
 *
 * Ordered by position so completions read in the table's own column order,
 * which is the order someone scanning a schema expects.
 */
export async function columnNamespace(): Promise<
  Record<string, Record<string, string[]>>
> {
  return memo(namespaceCache, "", async () => {
    const resultSet = await clickhouse.query({
      query: `
        SELECT database, table, name
        FROM system.columns
        WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
        ORDER BY database, table, position
      `,
      format: "JSONEachRow",
    });

    const rows = await resultSet.json<{
      database: string;
      table: string;
      name: string;
    }>();

    const out: Record<string, Record<string, string[]>> = {};
    for (const row of rows) {
      const db = (out[row.database] ??= {});
      (db[row.table] ??= []).push(row.name);
    }
    return out;
  });
}

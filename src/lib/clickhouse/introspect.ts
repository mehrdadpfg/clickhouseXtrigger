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

export type TableSummary = {
  database: string;
  name: string;
  engine: string;
  /** Null for engines that don't track a row count (e.g. views). */
  rows: number | null;
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
  sorting_key: string;
  comment: string;
};

function toSummary(row: TableRow): TableSummary {
  return {
    database: row.database,
    name: row.name,
    engine: row.engine,
    // total_rows is UInt64, which the JSON formats render as a string.
    rows: row.total_rows === null ? null : Number(row.total_rows),
    sortingKey: row.sorting_key,
    comment: row.comment,
  };
}

/**
 * Every queryable table/view, system databases excluded.
 *
 * @param database Restrict to one database. Omit for all user databases.
 */
export async function listTables(database?: string): Promise<TableSummary[]> {
  const resultSet = await clickhouse.query({
    query: `
      SELECT database, name, engine, total_rows, sorting_key, comment
      FROM system.tables
      WHERE database NOT IN ({systemDatabases:Array(String)})
        AND (empty({database:String}) OR database = {database:String})
      ORDER BY database, name
    `,
    format: "JSONEachRow",
    query_params: {
      systemDatabases: SYSTEM_DATABASES,
      database: database ?? "",
    },
  });

  const rows = await resultSet.json<TableRow>();
  return rows.map(toSummary);
}

/**
 * Columns + engine metadata for one table, or null when it doesn't exist.
 */
export async function describeTable(
  database: string,
  table: string,
): Promise<TableSchema | null> {
  const [summary] = await listTables(database).then((tables) =>
    tables.filter((t) => t.name === table),
  );

  if (!summary) return null;

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

  const columns = await resultSet.json<ColumnInfo>();
  return { ...summary, columns };
}

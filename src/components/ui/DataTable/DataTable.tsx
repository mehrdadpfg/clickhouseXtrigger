import type { ReactNode } from "react";
import styles from "./DataTable.module.css";

export type DataRow = Record<string, unknown>;
export type ColumnAlign = "left" | "right";

export interface DataColumn<Row extends DataRow = DataRow> {
  key: string;
  label: ReactNode;
  /**
   * Omit to let the table infer it from the data: numbers right, everything
   * else left. Columns arrive from runtime schema introspection, so the
   * common case should not need spelling out.
   */
  align?: ColumnAlign;
  format?: (value: unknown, row: Row) => ReactNode;
}

export interface DataTableProps<Row extends DataRow = DataRow> {
  columns: DataColumn<Row>[];
  rows: Row[];
  /** The bar under the table — counts on the left, actions on the right. */
  footer?: ReactNode;
  /** Enables the sticky header by giving the scroll container a bound. */
  maxHeight?: string;
  emptyMessage?: string;
  getRowKey?: (row: Row, index: number) => string;
  className?: string;
}

function defaultFormat(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Scans for the first non-null value in a column and aligns on its type.
 * A column that is entirely null falls back to left.
 */
function inferAlign<Row extends DataRow>(
  key: string,
  rows: Row[],
): ColumnAlign {
  for (const row of rows) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    return typeof value === "number" || typeof value === "bigint"
      ? "right"
      : "left";
  }
  return "left";
}

export function DataTable<Row extends DataRow = DataRow>({
  columns,
  rows,
  footer,
  maxHeight,
  emptyMessage = "No rows",
  getRowKey,
  className,
}: DataTableProps<Row>) {
  // Resolved once, and carried with the column rather than in a parallel array
  // that the header and body would each have to index into correctly.
  const resolved = columns.map((column) => ({
    column,
    align: column.align ?? inferAlign(column.key, rows),
  }));

  return (
    <div className={className}>
      <div className={styles.scroll} style={maxHeight ? { maxHeight } : undefined}>
        {/* tnum: columns of figures only line up with tabular digits. */}
        <table className={`tnum ${styles.table}`}>
          <thead>
            <tr>
              {resolved.map(({ column, align }) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`${styles.th} ${styles[align]}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={styles.empty} colSpan={columns.length}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr
                  key={getRowKey ? getRowKey(row, rowIndex) : rowIndex}
                  className={styles.row}
                >
                  {resolved.map(({ column, align }) => {
                    const value = row[column.key];
                    return (
                      <td
                        key={column.key}
                        className={`${styles.td} ${styles[align]}`}
                      >
                        {column.format
                          ? column.format(value, row)
                          : defaultFormat(value)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}

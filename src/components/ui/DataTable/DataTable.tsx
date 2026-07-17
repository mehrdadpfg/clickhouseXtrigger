import type { ReactNode } from "react";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../shadcn/table";
import { cn } from "@/lib/utils";

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
      {/* Container carries the card radius; the scroll bound makes the header
          sticky. tnum: columns of figures only line up with tabular digits. */}
      <div
        className="overflow-auto rounded-[var(--r-lg)]"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <table className="tnum w-full border-collapse font-sans text-[12.5px]">
          <TableHeader className="sticky top-0 z-10 [&_tr]:border-0">
            <tr>
              {resolved.map(({ column, align }) => (
                <TableHead
                  key={column.key}
                  scope="col"
                  className={cn(
                    "h-auto border-b border-border bg-card px-[14px] py-[9px] font-mono text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--text-faint)]",
                    align === "right" ? "text-right" : "text-left",
                  )}
                >
                  {column.label}
                </TableHead>
              ))}
            </tr>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="border-0 hover:bg-transparent">
                <TableCell
                  className="border-t border-border px-[14px] py-[18px] text-center text-[12.5px] text-muted-foreground"
                  colSpan={columns.length}
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, rowIndex) => (
                <TableRow
                  key={getRowKey ? getRowKey(row, rowIndex) : rowIndex}
                  className="border-0 hover:bg-[var(--surface-3)]"
                >
                  {resolved.map(({ column, align }, colIndex) => {
                    const value = row[column.key];
                    return (
                      <TableCell
                        key={column.key}
                        className={cn(
                          "whitespace-normal border-t border-border px-[14px] py-2",
                          // The first column is the row's identity — full-strength text.
                          colIndex === 0
                            ? "text-[var(--text)]"
                            : "text-[var(--text-secondary)]",
                          align === "right" ? "text-right" : "text-left",
                        )}
                      >
                        {column.format
                          ? column.format(value, row)
                          : defaultFormat(value)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </table>
      </div>

      {footer ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-[14px] py-2 font-mono text-[10.5px] text-[var(--text-faint)]">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

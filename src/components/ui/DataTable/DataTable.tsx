import { useMemo, useState, type ReactNode } from "react";
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
  /**
   * Let the reader sort by clicking a header. Off by default: most tables here
   * are short receipts whose row order is the answer (a ranked bar's rows are
   * already ranked), and a sortable header invites reordering that loses that.
   */
  sortable?: boolean;
}

/**
 * Compare two cells for sorting.
 *
 * Numeric strings compare NUMERICALLY: ClickHouse returns 64-bit ints as JSON
 * strings, so a lexical sort would put "1000" before "9" on a plain count
 * column — the single most likely column anyone clicks.
 */
function compareValues(a: unknown, b: unknown): number {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (empty(a) && empty(b)) return 0;
  // Nulls sort last in either direction; they are absence, not a small value.
  if (empty(a)) return 1;
  if (empty(b)) return -1;

  const na = typeof a === "number" ? a : Number(String(a));
  const nb = typeof b === "number" ? b : Number(String(b));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (Number.isFinite(na) && Number.isFinite(nb)) return 0;

  return String(a).localeCompare(String(b), undefined, { numeric: true });
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
  sortable = false,
}: DataTableProps<Row>) {
  // null = the query's own order, which is meaningful often enough to be the
  // state a third click returns to rather than flipping between asc and desc
  // forever.
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    null,
  );

  const ordered = useMemo(() => {
    if (!sort) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareValues(a[sort.key], b[sort.key]);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  const cycle = (key: string) =>
    setSort((prev) =>
      prev?.key !== key
        ? { key, dir: "desc" }
        : prev.dir === "desc"
          ? { key, dir: "asc" }
          : null,
    );
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
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => cycle(column.key)}
                      className={cn(
                        "inline-flex w-full items-center gap-1 uppercase tracking-[0.05em] hover:text-[var(--text)]",
                        align === "right" ? "justify-end" : "justify-start",
                        sort?.key === column.key ? "text-[var(--text)]" : "",
                      )}
                      aria-label={`Sort by ${String(column.label)}`}
                    >
                      {column.label}
                      <span aria-hidden="true">
                        {sort?.key === column.key
                          ? sort.dir === "desc"
                            ? "\u2193"
                            : "\u2191"
                          : ""}
                      </span>
                    </button>
                  ) : (
                    column.label
                  )}
                </TableHead>
              ))}
            </tr>
          </TableHeader>
          <TableBody>
            {ordered.length === 0 ? (
              <TableRow className="border-0 hover:bg-transparent">
                <TableCell
                  className="border-t border-border px-[14px] py-[18px] text-center text-[12.5px] text-muted-foreground"
                  colSpan={columns.length}
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              ordered.map((row, rowIndex) => (
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

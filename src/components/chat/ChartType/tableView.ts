/**
 * The "show this as a table" sentinel, in its own module so the server can see it.
 *
 * It is a *view* selection, never a chart type: nothing downstream can compile
 * `chartType: "__table__"` into a spec, so a tile that persisted it would render
 * empty forever. The board's write path has to reject it, and a server action
 * cannot import ChartTypeMenu to find out what it is — that file is "use client"
 * and drags React hooks and icons with it.
 */
export const TABLE_VIEW = "__table__";

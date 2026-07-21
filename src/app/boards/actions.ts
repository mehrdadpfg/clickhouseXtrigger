"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  addTile,
  createBoard,
  getBoard,
  getTile,
  listBoards,
  listBoardsWithTileCount,
  listTiles,
  removeTile,
  reorderTiles,
  updateTile,
} from "@/lib/db/boards";
import {
  GRID_COLUMNS,
  MAX_TILE_ROWS,
  readSpec,
  resolveSpan,
  type BoardOption,
  type TileUpdate,
  type TileDraftValues,
} from "@/components/boards/model";
import { TABLE_VIEW } from "@/components/shared/ChartType/tableView";
import {
  runReadonlyQueries,
  runReadonlyQuery,
  runReadonlyQueryWithCost,
  type QueryCost,
} from "@/lib/clickhouse/run";
import { columnNamespace, maxDateIn } from "@/lib/clickhouse/introspect";
import type {
  ActionResult,
  BoardResult,
  TileResult,
} from "@/components/boards/model";

/**
 * The Boards screen's writes.
 *
 * A server action is a public HTTP endpoint with a nice-looking call site: the
 * arguments arrive over the network and are trustworthy only after they are
 * parsed here. Nothing below interpolates a caller-supplied string into SQL —
 * board and tile mutations go through lib/db/boards (every value bound), and a
 * tile's *stored* SQL is run by id, fetched from Postgres, never taken from the
 * browser.
 *
 * The one exception is runTileDraftAction, which the studio's editor needs: it
 * runs the query the author is TYPING, so it cannot work by id. That path is
 * bounded exactly as the chat's own editor is — READONLY_SETTINGS caps every
 * run, and a shape check refuses anything but a single SELECT/WITH before
 * ClickHouse is asked. See the note on that action.
 *
 * These are handed to the components as props by the route, so nothing under
 * components/ imports lib/db — dependencies stay app -> components -> lib.
 */

const Id = z.uuid();

const Title = z.string().trim().min(1, "Name the board.").max(120);

const Draft = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), boardId: z.uuid() }),
    z.object({ kind: z.literal("new"), title: Title }),
  ]),
  kind: z.enum(["kpi", "chart", "table"]),
  title: z.string().trim().min(1, "Give the tile a title.").max(120),
  sql: z.string().trim().min(1, "The tile needs a query.").max(8_000),
  unit: z.enum(["$", "%"]).optional(),
});

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Runs a tile's stored SQL and hands back the rows. Takes a tile id — the SQL
 * is read from Postgres, so a caller cannot smuggle a statement in.
 */
export async function runTileAction(tileId: unknown): Promise<TileResult> {
  const parsed = Id.safeParse(tileId);
  if (!parsed.success) return fail("Unknown tile.");

  try {
    const tile = await getTile(parsed.data);
    if (!tile) return fail("That tile no longer exists.");

    const rows = await runReadonlyQuery(tile.sql);
    return { ok: true, rows };
  } catch (cause) {
    console.error("Run tile failed", cause);
    return fail(messageOf(cause, "The query did not run. Try again."));
  }
}

/**
 * Runs the query the tile editor is CURRENTLY showing — the draft in the
 * studio's SQL box — and hands back its rows and what it cost.
 *
 * Unlike runTileAction this takes SQL, not an id, because the studio previews an
 * edit the author has not saved: there is no stored statement to fetch. That
 * makes it the one board action that executes browser-supplied SQL, so it is
 * guarded the same way the chat's workspace runner is (runWorkspaceQuery): the
 * statement must be a single SELECT/WITH and nothing else runs, and
 * READONLY_SETTINGS (readonly=2, a runtime cap, a row cap) bounds it regardless.
 * It is not a new capability — the studio already runs edited SQL in the chat;
 * this is the same door on the board's side of the app.
 */
export async function runTileDraftAction(
  sql: unknown,
): Promise<
  | { ok: true; rows: Record<string, unknown>[]; cost: QueryCost | null }
  | { ok: false; error: string }
> {
  if (typeof sql !== "string") return fail("The query is empty.");
  const trimmed = sql.trim().replace(/;\s*$/, "");

  if (trimmed === "") return fail("The query is empty.");
  if (trimmed.includes(";")) {
    return fail("One statement at a time — remove the semicolon.");
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    return fail("Only SELECT (or WITH … SELECT) can run here.");
  }

  try {
    const { rows, cost } = await runReadonlyQueryWithCost(trimmed);
    return { ok: true, rows, cost };
  } catch (cause) {
    // ClickHouse errors are long and prefixed; the first line carries the point.
    const message = cause instanceof Error ? cause.message : String(cause);
    return fail(message.split("\n")[0]!.slice(0, 300));
  }
}

/**
 * The column namespace the tile editor completes against. Returns {} on failure
 * — autocomplete is a convenience, and an editor that still opens without it
 * beats one that won't open at all. Cached in introspection, so repeated opens
 * across a session cost one sweep.
 */
export async function getTileEditorSchemaAction(): Promise<
  Record<string, Record<string, string[]>>
> {
  try {
    return await columnNamespace();
  } catch (cause) {
    console.error("Could not load the schema for the tile editor", cause);
    return {};
  }
}

/**
 * The latest value in one column, for the studio's partial-bucket warning.
 * Identifiers are validated against system.columns inside maxDateIn before any
 * query is built. Returns null on anything unexpected: a missing warning is
 * fine, a wrong one teaches the reader to ignore the next.
 */
export async function getTileEditorMaxDateAction(
  database: string,
  table: string,
  column: string,
): Promise<string | null> {
  try {
    const max = await maxDateIn(database, table, column);
    return max ? max.toISOString() : null;
  } catch (cause) {
    console.error("Could not read the max date", database, table, column, cause);
    return null;
  }
}

/**
 * Runs every tile on a board and hands back each one's rows, keyed by tile id.
 *
 * This exists because of a property of the transport, not of the queries: Next
 * serialises server-action POSTs from one client, so ten tiles calling
 * runTileAction is ten round trips end to end — measured at 4.8s of wall clock
 * for 4.8s of query time, with never more than one in flight. No amount of
 * client-side scheduling can widen that; the fan-out has to happen server-side,
 * which is what this does.
 *
 * Takes a board id and reads the tiles itself rather than accepting a list of
 * tile ids from the browser. That is one Postgres statement instead of the N
 * getTile calls the per-tile action made, and it also means a caller cannot
 * assemble a batch of tiles from boards it is not looking at.
 *
 * Failure is per tile: runReadonlyQueries turns a rejection into an `ok: false`
 * entry, so a tile whose column was renamed upstream reports its own error while
 * the rest of the board renders. Only a board-level failure (no such board,
 * Postgres down) fails the call.
 */
export async function runBoardAction(boardId: unknown): Promise<BoardResult> {
  const parsed = Id.safeParse(boardId);
  if (!parsed.success) return fail("Unknown board.");

  try {
    const tiles = await listTiles(parsed.data);
    const results = await runReadonlyQueries(tiles.map((tile) => tile.sql));

    const byTile: Record<string, TileResult> = {};
    tiles.forEach((tile, index) => {
      byTile[tile.id] = results[index]!;
    });
    return { ok: true, tiles: byTile };
  } catch (cause) {
    console.error("Run board failed", cause);
    return fail(messageOf(cause, "The board did not load. Try again."));
  }
}

export async function createBoardAction(
  title: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = Title.safeParse(title);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Name the board.");
  }

  try {
    const board = await createBoard({ title: parsed.data });
    revalidatePath("/boards");
    return { ok: true, data: { id: board.id } };
  } catch (cause) {
    console.error("Create board failed", cause);
    return fail(messageOf(cause, "Could not create the board. Try again."));
  }
}

export async function addTileAction(draft: unknown): Promise<ActionResult> {
  const parsed = Draft.safeParse(draft);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid tile.");
  }

  const { target, kind, title, sql, unit } = parsed.data;

  try {
    // A new board is minted first; an existing one is confirmed to still be
    // there, so a tile is never orphaned onto a deleted board.
    let boardId: string;
    if (target.kind === "new") {
      boardId = (await createBoard({ title: target.title })).id;
    } else {
      const board = await getBoard(target.boardId);
      if (!board) return fail("That board no longer exists.");
      boardId = board.id;
    }

    await addTile({
      boardId,
      kind,
      title,
      sql,
      // unit is the only render hint the modal collects; the tile's shapers
      // read it out of spec. An absent unit leaves the number to stand alone.
      spec: unit ? { unit } : {},
    });

    revalidatePath("/boards");
    revalidatePath(`/boards/${boardId}`);
    return { ok: true };
  } catch (cause) {
    console.error("Add tile failed", cause);
    return fail(messageOf(cause, "Could not add the tile. Try again."));
  }
}

export async function removeTileAction(tileId: unknown): Promise<ActionResult> {
  const parsed = Id.safeParse(tileId);
  if (!parsed.success) return fail("Unknown tile.");

  try {
    const removed = await removeTile(parsed.data);
    if (!removed) return fail("That tile no longer exists.");
    revalidatePath("/boards");
    return { ok: true };
  } catch (cause) {
    console.error("Remove tile failed", cause);
    return fail(messageOf(cause, "Could not remove the tile. Try again."));
  }
}

const Reorder = z.object({
  boardId: Id,
  orderedIds: z.array(Id).max(200),
});

/**
 * Persist a new tile order after a drag on the board.
 *
 * `orderedIds` is authoritative over the whole board: reorderTiles packs those
 * ids into dense positions and appends anything left out, so a stale or partial
 * list from the browser can never strand two tiles on the same slot. Ids that
 * aren't on this board are ignored on the DB side.
 */
export async function reorderTilesAction(input: unknown): Promise<ActionResult> {
  const parsed = Reorder.safeParse(input);
  if (!parsed.success) return fail("Invalid tile order.");

  try {
    const board = await getBoard(parsed.data.boardId);
    if (!board) return fail("That board no longer exists.");
    await reorderTiles(parsed.data.boardId, parsed.data.orderedIds);
    revalidatePath(`/boards/${parsed.data.boardId}`);
    return { ok: true };
  } catch (cause) {
    console.error("Reorder tiles failed", cause);
    return fail(messageOf(cause, "Could not save the new order. Try again."));
  }
}

const SaveLayout = z.object({
  boardId: Id,
  items: z
    .array(
      z.object({
        tileId: Id,
        x: z.number().int().min(0).max(10_000),
        y: z.number().int().min(0).max(10_000),
        w: z.number().int().min(1).max(GRID_COLUMNS),
        h: z.number().int().min(1).max(MAX_TILE_ROWS),
      }),
    )
    .max(200),
});

/**
 * Persist the board's gridstack layout after a drag or a resize.
 *
 * gridstack settles the whole grid on one gesture — a resize reflows the tiles
 * below it — so the client sends every tile's footprint in one call rather than
 * one write per tile. Each item's x/y/w/h is MERGED onto the tile's existing
 * spec bag, so a tile keeps its SQL and chart spec; only its geometry changes.
 * The legacy `span` is dropped in favour of `w`, so a tile has a single width of
 * record once it has been placed on the new grid.
 *
 * Deliberately does NOT revalidate: the client already shows the settled layout
 * (gridstack moved the tiles), and the page is force-dynamic, so the next load
 * reads the fresh geometry anyway. Revalidating here would push an RSC re-render
 * into the middle of a drag for no visible gain.
 */
export async function saveBoardLayoutAction(
  input: unknown,
): Promise<ActionResult> {
  const parsed = SaveLayout.safeParse(input);
  if (!parsed.success) return fail("Invalid layout.");

  const { boardId, items } = parsed.data;
  if (items.length === 0) return { ok: true };

  try {
    const tiles = await listTiles(boardId);
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));

    for (const item of items) {
      const tile = byId.get(item.tileId);
      // A tile removed out from under the drag: skip it rather than resurrect a
      // geometry row for something that no longer exists.
      if (!tile) continue;

      const spec: Record<string, unknown> = { ...(tile.spec ?? {}) };
      spec["x"] = item.x;
      spec["y"] = item.y;
      spec["w"] = item.w;
      spec["h"] = item.h;
      // Superseded by `w` — remove it so width is stored in exactly one place.
      delete spec["span"];

      await updateTile(item.tileId, { spec });
    }

    return { ok: true };
  } catch (cause) {
    console.error("Save board layout failed", cause);
    return fail(messageOf(cause, "Could not save the layout. Try again."));
  }
}

/**
 * Boards the "Add to dashboard" picker offers. id + title only — enough to list
 * and target, nothing that needs the tiles loaded.
 */
export async function listBoardsForPickerAction(): Promise<
  { id: string; title: string }[]
> {
  try {
    return (await listBoards()).map((b) => ({ id: b.id, title: b.title }));
  } catch (cause) {
    console.error("List boards failed", cause);
    return [];
  }
}

/**
 * Boards offered by the chat composer's @-mention picker — id, title and tile
 * count, the same shape the "Add to dashboard" picker uses. Read once per
 * composer mount, so a stale count is cheap; the count is only a hint on the row.
 */
export async function listBoardsForMentionAction(): Promise<BoardOption[]> {
  try {
    return (await listBoardsWithTileCount()).map((b) => ({
      id: b.id,
      title: b.title,
      tileCount: Number(b.tile_count),
    }));
  } catch (cause) {
    console.error("List boards for mention failed", cause);
    return [];
  }
}

const PinCharts = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), boardId: z.uuid() }),
    z.object({ kind: z.literal("new"), title: Title }),
  ]),
  charts: z
    .array(
      z.object({
        title: z.string().trim().min(1, "Give the tile a title.").max(120),
        sql: z.string().trim().min(1, "The chart needs its query.").max(8_000),
        spec: z.object({
          chartType: z.string().trim().min(1),
          encodings: z.record(z.string(), z.string()),
          horizontal: z.boolean().optional(),
          semanticTypes: z.record(z.string(), z.string()).optional(),
          span: z.number().int().min(1).max(4).optional(),
        }),
      }),
    )
    .min(1, "No chart to add.")
    .max(24),
});

/**
 * Pin a chat answer's chart(s) onto a board. Each tile stores its query (re-run
 * live on the board) plus the flint chart spec, so the board renders the exact
 * charts the thread showed — recomputed against fresh data each load. A
 * dashboard-style answer lands as several tiles on one board in a single call.
 */
export async function pinChartsToBoardAction(
  draft: unknown,
): Promise<ActionResult> {
  const parsed = PinCharts.safeParse(draft);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid chart.");
  }

  const { target, charts } = parsed.data;

  try {
    // The board is minted (or confirmed) once, then every chart is added to it,
    // so a dashboard answer never scatters its tiles across boards.
    let boardId: string;
    if (target.kind === "new") {
      boardId = (await createBoard({ title: target.title })).id;
    } else {
      const board = await getBoard(target.boardId);
      if (!board) return fail("That board no longer exists.");
      boardId = board.id;
    }

    // Sequential, not parallel: addTile appends at the next position, so
    // ordering the writes keeps the tiles in the order the answer drew them.
    for (const chart of charts) {
      await addTile({
        boardId,
        kind: "chart",
        title: chart.title,
        sql: chart.sql,
        spec: chart.spec,
      });
    }

    revalidatePath("/boards");
    revalidatePath(`/boards/${boardId}`);
    return { ok: true };
  } catch (cause) {
    console.error("Pin charts failed", cause);
    return fail(messageOf(cause, "Could not add the charts. Try again."));
  }
}

const ChartTile = z.object({
  title: z.string().trim().min(1, "Give the tile a title.").max(120),
  sql: z.string().trim().min(1, "The chart needs its query.").max(8_000),
  spec: z.object({
    chartType: z.string().trim().min(1),
    encodings: z.record(z.string(), z.string()),
    horizontal: z.boolean().optional(),
    semanticTypes: z.record(z.string(), z.string()).optional(),
    span: z.number().int().min(1).max(4).optional(),
  }),
});

const PinStats = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), boardId: z.uuid() }),
    z.object({ kind: z.literal("new"), title: Title }),
  ]),
  stats: z
    .array(
      z.object({
        label: z.string().trim().min(1, "Give the stat a name.").max(120),
        sql: z.string().trim().min(1, "The stat needs its query.").max(8_000),
        // "×" is carried through but only "$"/"%" change the number's shape;
        // formatMetric drops the rest, so an unknown unit is safe to store.
        unit: z.enum(["", "$", "%", "×"]).optional(),
        // Which result column holds this metric — set when the stat was matched
        // to a query returning several numbers, so toKpi reads the right one
        // instead of defaulting to the first numeric column.
        valueColumn: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .min(1, "No stat to add.")
    .max(24),
  // A mixed answer (charts + a KPI) pins onto ONE board through this action, so
  // charts ride along here rather than minting a second board of their own.
  charts: z.array(ChartTile).max(24).optional(),
});

/**
 * Pin a chat answer's headline number(s) onto a board as KPI tiles — and, when
 * the same answer also drew charts, those in the same call so the whole answer
 * lands on one board. Each KPI tile stores its query (re-run live) plus a spec
 * carrying the metric's label + unit, so the board renders it through toKpi with
 * the right header — the metric's name on top, the formatted value below.
 */
export async function pinStatsToBoardAction(
  draft: unknown,
): Promise<ActionResult> {
  const parsed = PinStats.safeParse(draft);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid stat.");
  }

  const { target, stats, charts = [] } = parsed.data;

  try {
    // Mint (or confirm) the board once, then add every tile to it, so a mixed
    // answer never scatters its tiles across boards.
    let boardId: string;
    if (target.kind === "new") {
      boardId = (await createBoard({ title: target.title })).id;
    } else {
      const board = await getBoard(target.boardId);
      if (!board) return fail("That board no longer exists.");
      boardId = board.id;
    }

    // Sequential, not parallel: addTile appends at the next position, so
    // ordering the writes keeps the tiles in the order the answer showed them.
    // Stats BEFORE charts, matching the chat's layout — the KPI strip sits above
    // the chart grid there, so the board reads the same way instead of leading
    // with charts and burying the numbers at the end.
    for (const stat of stats) {
      await addTile({
        boardId,
        kind: "kpi",
        // The title is the tile's identity; the label (in the spec) is the
        // metric's name the KPI header reads. Same string, different jobs.
        title: stat.label,
        sql: stat.sql,
        // Store the label so toKpi shows the metric's name, not the tile title;
        // only carry a unit formatMetric understands ('' and '×' add nothing).
        spec: {
          label: stat.label,
          ...(stat.unit === "$" || stat.unit === "%" ? { unit: stat.unit } : {}),
          ...(stat.valueColumn ? { valueColumn: stat.valueColumn } : {}),
        },
      });
    }

    for (const chart of charts) {
      await addTile({
        boardId,
        kind: "chart",
        title: chart.title,
        sql: chart.sql,
        spec: chart.spec,
      });
    }

    revalidatePath("/boards");
    revalidatePath(`/boards/${boardId}`);
    return { ok: true };
  } catch (cause) {
    console.error("Pin stats failed", cause);
    return fail(messageOf(cause, "Could not add the stats. Try again."));
  }
}

const TileId = z.uuid();

/**
 * The tile write path's one gate.
 *
 * `satisfies z.ZodType<TileUpdate>` looks like it keeps this in step with the
 * interface. It does not, in either direction: zod strips keys the shape does
 * not name, so a field that exists only on TileUpdate is quietly discarded here
 * and the caller still gets {ok:true}. Adding to the interface is therefore
 * never enough — the field has to be named below AND written in the merge body
 * of updateTileAction, or the write is a no-op nobody reports.
 */
const UpdateTileFields = z.object({
  tileId: z.uuid(),
  title: z.string().trim().min(1, "Give the tile a title.").max(120).optional(),
  kind: z.enum(["kpi", "chart", "table"]).optional(),
  sql: z.string().trim().min(1, "The tile needs a query.").max(8_000).optional(),
  unit: z.enum(["", "$", "%"]).optional(),
  span: z.number().int().min(1).max(4).optional(),
  chartType: z.string().trim().min(1).optional(),
  encodings: z.record(z.string(), z.string()).optional(),
  horizontal: z.boolean().optional(),
}) satisfies z.ZodType<TileUpdate>;

const UpdateTile = UpdateTileFields.superRefine((update, ctx) => {
  // The table sentinel is a view toggle in the chat, not a chart type. flint has
  // no such family, so a tile that stored it would compile no spec and render
  // "No data" forever, with nothing on screen explaining why. A table tile is
  // kind: "table".
  if (update.chartType === TABLE_VIEW) {
    ctx.addIssue({
      code: "custom",
      path: ["chartType"],
      message: 'A table is a tile kind, not a chart type — save it as kind "table".',
    });
  }

  // A chart type names the family; the encodings say which column feeds which
  // channel. Persisting the first without the second leaves the tile inferring
  // channels from the result shape — which is what an unspecified tile already
  // does, so the saved chartType would appear to have been ignored.
  if (
    update.chartType !== undefined &&
    Object.keys(update.encodings ?? {}).length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["encodings"],
      message: "A chart type needs encodings saying which column feeds which channel.",
    });
  }
});

/**
 * The editable fields of a tile, for the edit modal to pre-fill. Takes an id and
 * reads the row server-side — the SQL lives on the server and is handed back only
 * to the tile's own editor.
 */
export async function loadTileDraftAction(
  tileId: unknown,
): Promise<TileDraftValues | null> {
  const parsed = TileId.safeParse(tileId);
  if (!parsed.success) return null;
  try {
    const tile = await getTile(parsed.data);
    if (!tile) return null;
    const spec = readSpec(tile.spec);
    return {
      title: tile.title,
      kind: tile.kind,
      sql: tile.sql,
      unit: spec.unit ?? "",
      span: resolveSpan(spec.span, tile.kind),
    };
  } catch (cause) {
    console.error("Load tile draft failed", cause);
    return null;
  }
}

/**
 * Edit a tile — its title/kind/SQL and its display hints (unit, width). The spec
 * is merged, not replaced, so a chart tile keeps its chartType/encodings when the
 * analyst only changes the width or unit.
 */
export async function updateTileAction(input: unknown): Promise<ActionResult> {
  const parsed = UpdateTile.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid change.");
  }
  const { tileId, title, kind, sql, unit, span, chartType, encodings, horizontal } =
    parsed.data;

  try {
    const tile = await getTile(tileId);
    if (!tile) return fail("That tile no longer exists.");

    // Merge onto the raw spec bag so chart fields survive a unit/width edit.
    const spec: Record<string, unknown> = { ...(tile.spec ?? {}) };
    if (unit !== undefined) {
      if (unit === "") delete spec["unit"];
      else spec["unit"] = unit;
    }
    if (span !== undefined) spec["span"] = span;
    if (chartType !== undefined) spec["chartType"] = chartType;
    if (encodings !== undefined) spec["encodings"] = encodings;
    if (horizontal !== undefined) spec["horizontal"] = horizontal;

    await updateTile(tileId, {
      ...(title !== undefined ? { title } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(sql !== undefined ? { sql } : {}),
      spec,
    });

    revalidatePath("/boards");
    revalidatePath(`/boards/${tile.board_id}`);
    return { ok: true };
  } catch (cause) {
    console.error("Update tile failed", cause);
    return fail(messageOf(cause, "Could not save the tile. Try again."));
  }
}

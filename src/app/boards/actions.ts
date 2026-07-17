"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  addTile,
  createBoard,
  getBoard,
  getTile,
  listBoards,
  removeTile,
} from "@/lib/db/boards";
import { runReadonlyQuery } from "@/lib/clickhouse/run";
import type { ActionResult, TileResult } from "@/components/boards/model";

/**
 * The Boards screen's writes.
 *
 * A server action is a public HTTP endpoint with a nice-looking call site: the
 * arguments arrive over the network and are trustworthy only after they are
 * parsed here. Nothing below interpolates a caller-supplied string into SQL —
 * board and tile mutations go through lib/db/boards (every value bound), and
 * the one query that reaches ClickHouse runs a tile's *stored* SQL, fetched by
 * id, never SQL sent from the browser.
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

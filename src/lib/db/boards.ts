/**
 * Boards and their tiles — pinned results.
 *
 * A tile stores the SQL that produces it, so a board re-runs live rather than
 * caching a snapshot. `spec` carries render config and stays opaque here.
 *
 * Server-only. Every value is passed as a bind parameter — never interpolated.
 */
import { query } from "@/lib/db/client";
import type {
  BoardRow,
  BoardTileKind,
  BoardTileRow,
  BoardTileSpec,
  BoardWithTileCountRow,
} from "@/types/db";

const BOARD_COLUMNS = "id, title, created_at, updated_at";
const TILE_COLUMNS = "id, board_id, kind, title, sql, spec, position";

// --- boards ----------------------------------------------------------------

export async function listBoards(): Promise<BoardRow[]> {
  return query<BoardRow>(
    `select ${BOARD_COLUMNS} from boards order by updated_at desc`,
  );
}

/** The board picker shows "N tiles" alongside each board. */
export async function listBoardsWithTileCount(): Promise<BoardWithTileCountRow[]> {
  return query<BoardWithTileCountRow>(
    `select b.id, b.title, b.created_at, b.updated_at,
            count(t.id)::bigint as tile_count
     from boards b
     left join board_tiles t on t.board_id = b.id
     group by b.id
     order by b.updated_at desc`,
  );
}

export async function getBoard(id: string): Promise<BoardRow | null> {
  const rows = await query<BoardRow>(
    `select ${BOARD_COLUMNS} from boards where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createBoard(input: {
  title: string;
  id?: string;
}): Promise<BoardRow> {
  const rows = await query<BoardRow>(
    `insert into boards (id, title)
     values (coalesce($1::uuid, gen_random_uuid()), $2)
     returning ${BOARD_COLUMNS}`,
    [input.id ?? null, input.title],
  );
  return rows[0]!;
}

export async function renameBoard(
  id: string,
  title: string,
): Promise<BoardRow | null> {
  const rows = await query<BoardRow>(
    `update boards set title = $2, updated_at = now()
     where id = $1
     returning ${BOARD_COLUMNS}`,
    [id, title],
  );
  return rows[0] ?? null;
}

/** Cascades to this board's tiles. Returns false if it did not exist. */
export async function deleteBoard(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from boards where id = $1 returning id`,
    [id],
  );
  return rows.length > 0;
}

// --- tiles -----------------------------------------------------------------

export async function listTiles(boardId: string): Promise<BoardTileRow[]> {
  return query<BoardTileRow>(
    `select ${TILE_COLUMNS} from board_tiles
     where board_id = $1
     order by position, id`,
    [boardId],
  );
}

export async function getTile(id: string): Promise<BoardTileRow | null> {
  const rows = await query<BoardTileRow>(
    `select ${TILE_COLUMNS} from board_tiles where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Appends to the end of the board. Position is computed in the statement rather
 * than read-then-written, so two concurrent adds can't land on the same slot.
 */
export async function addTile(input: {
  boardId: string;
  kind: BoardTileKind;
  title: string;
  sql: string;
  spec?: BoardTileSpec;
}): Promise<BoardTileRow> {
  const rows = await query<BoardTileRow>(
    `insert into board_tiles (board_id, kind, title, sql, spec, position)
     select $1, $2, $3, $4, $5::jsonb,
            coalesce(max(position) + 1, 0)
     from board_tiles where board_id = $1
     returning ${TILE_COLUMNS}`,
    [input.boardId, input.kind, input.title, input.sql, JSON.stringify(input.spec ?? {})],
  );
  return rows[0]!;
}

export type BoardTilePatch = {
  kind?: BoardTileKind;
  title?: string;
  sql?: string;
  spec?: BoardTileSpec;
  position?: number;
};

// Whitelist: patch key -> column. The SET clause is built from these constants
// only, so no caller-supplied string reaches the SQL text.
const PATCHABLE = {
  kind: "kind",
  title: "title",
  sql: "sql",
  spec: "spec",
  position: "position",
} as const satisfies Record<keyof BoardTilePatch, string>;

export async function updateTile(
  id: string,
  patch: BoardTilePatch,
): Promise<BoardTileRow | null> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  for (const key of Object.keys(PATCHABLE) as (keyof BoardTilePatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;

    const column = PATCHABLE[key];
    values.push(key === "spec" ? JSON.stringify(value) : value);
    // $1 is the id, so the first assignment binds to $2.
    assignments.push(
      key === "spec"
        ? `${column} = $${values.length}::jsonb`
        : `${column} = $${values.length}`,
    );
  }

  if (assignments.length === 0) return getTile(id);

  const rows = await query<BoardTileRow>(
    `update board_tiles set ${assignments.join(", ")}
     where id = $1
     returning ${TILE_COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

export async function removeTile(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from board_tiles where id = $1 returning id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Rewrites the board's tile order in one statement — no read-modify-write race.
 *
 * Authoritative over the whole board, not just the ids passed in: tiles named in
 * `orderedIds` take those slots in order, and any tile left out is appended
 * after, keeping its previous relative order. That makes the result always dense
 * and collision-free — a partial list can't strand two tiles on the same
 * position. Ids not on this board are ignored. Returns the reordered tiles.
 */
export async function reorderTiles(
  boardId: string,
  orderedIds: string[],
): Promise<BoardTileRow[]> {
  if (orderedIds.length === 0) return listTiles(boardId);

  await query(
    `with desired as (
       select id, (ordinality - 1)::int as pos
       from unnest($2::uuid[]) with ordinality as o(id, ordinality)
     ),
     final as (
       select t.id,
              (row_number() over (
                 -- Listed tiles first, in the given order; everything else
                 -- after, still in its old order. The id column breaks any
                 -- remaining tie so the result is deterministic.
                 order by case when d.pos is null then 1 else 0 end,
                          d.pos,
                          t.position,
                          t.id
               ) - 1)::int as pos
       from board_tiles t
       left join desired d on d.id = t.id
       where t.board_id = $1
     )
     update board_tiles t
     set position = f.pos
     from final f
     where t.id = f.id and t.position is distinct from f.pos`,
    [boardId, orderedIds],
  );
  return listTiles(boardId);
}

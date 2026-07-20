import { BoardsList, type BoardActions, type BoardListItem } from "@/components/boards";
import { relativeTime } from "@/components/shared/HistorySidebar";
import { listBoardsWithTileCount } from "@/lib/db/boards";
import {
  addTileAction,
  createBoardAction,
  removeTileAction,
  reorderTilesAction,
  runBoardAction,
  runTileAction,
  updateTileAction,
} from "./actions";

/**
 * "/boards" — the boards index.
 *
 * An RSC: the board list is read at request time and every timestamp is
 * formatted server-side (see relativeTime for why a browser clock cannot be
 * trusted to agree). The actions are handed to the components as props rather
 * than imported by them, so dependencies stay app -> components -> lib and
 * lib/db — which holds the connection string — never ships to a browser.
 */
export const dynamic = "force-dynamic";

const actions: BoardActions = {
  run: runTileAction,
  runBoard: runBoardAction,
  createBoard: createBoardAction,
  addTile: addTileAction,
  removeTile: removeTileAction,
  updateTile: updateTileAction,
  reorder: reorderTilesAction,
};

async function load(): Promise<{ boards: BoardListItem[]; error?: string }> {
  try {
    // One clock for the whole render, so two "2h"s cannot disagree because the
    // second one was formatted a moment later.
    const now = new Date();
    const rows = await listBoardsWithTileCount();

    return {
      boards: rows.map((row) => {
        const at = row.updated_at ?? row.created_at;
        return {
          id: row.id,
          title: row.title,
          tileCount: row.tile_count,
          isoTime: at.toISOString(),
          timeLabel: relativeTime(at, now),
        };
      }),
    };
  } catch (cause) {
    // A dead Postgres is a state to render, not a 500 — the same call the
    // Watchers page makes about its store.
    console.error("Boards page load failed", cause);
    return {
      boards: [],
      error:
        cause instanceof Error
          ? `Could not reach the board store: ${cause.message}`
          : "Could not reach the board store.",
    };
  }
}

export default async function BoardsPage() {
  const { boards, error } = await load();
  return <BoardsList boards={boards} actions={actions} error={error} />;
}

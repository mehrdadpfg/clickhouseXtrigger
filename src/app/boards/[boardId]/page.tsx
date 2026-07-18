import { notFound } from "next/navigation";
import {
  BoardDetail,
  toTileView,
  type BoardActions,
  type BoardView,
} from "@/components/boards";
import { getBoard, listTiles } from "@/lib/db/boards";
import {
  addTileAction,
  createBoardAction,
  removeTileAction,
  reorderTilesAction,
  runTileAction,
  updateTileAction,
} from "../actions";

/**
 * "/boards/:id" — one opened board.
 *
 * An RSC: the board and its tile definitions are read here, and only the tile
 * *shells* are rendered server-side. Each tile's live result is fetched by its
 * own client island through the `run` action, by id — the SQL never crosses
 * into the browser.
 */
export const dynamic = "force-dynamic";

const actions: BoardActions = {
  run: runTileAction,
  createBoard: createBoardAction,
  addTile: addTileAction,
  removeTile: removeTileAction,
  updateTile: updateTileAction,
  reorder: reorderTilesAction,
};

export default async function BoardPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  const { boardId } = await params;

  const board = await getBoard(boardId);
  if (!board) notFound();

  const tiles = await listTiles(board.id);

  const view: BoardView = {
    id: board.id,
    title: board.title,
    tiles: tiles.map(toTileView),
  };

  return <BoardDetail board={view} actions={actions} />;
}

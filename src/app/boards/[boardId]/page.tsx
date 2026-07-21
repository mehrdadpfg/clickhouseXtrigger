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
  runBoardAction,
  runTileAction,
  saveBoardLayoutAction,
  updateTileAction,
} from "../actions";

/**
 * "/boards/:id" — one opened board.
 *
 * An RSC: the board and its tile definitions are read here, and only the tile
 * *shells* are rendered server-side. The live results are fetched afterwards by
 * the client island, in one `runBoard` call for the whole board — by board id,
 * so the SQL never crosses into the browser in either direction.
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
  saveLayout: saveBoardLayoutAction,
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

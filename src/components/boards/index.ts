/* The Boards screens. Domain composition — the primitives these sit on are in
   components/ui, and the data they render is mapped by the route. */

export { BoardsList } from "./BoardsList/BoardsList";
export { BoardDetail } from "./BoardDetail/BoardDetail";

export {
  toTileView,
  toKpi,
  toChart,
  toTable,
  readSpec,
  formatMetric,
  formatCell,
  GRID_COLUMNS,
  TILE_KINDS,
  TILE_UNITS,
} from "./model";

export type {
  ActionResult,
  BoardActions,
  BoardListItem,
  BoardOption,
  BoardView,
  TileDraft,
  TileResult,
  TileTarget,
  TileView,
} from "./model";

"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { GridStack, type GridStackNode } from "gridstack";
import "gridstack/dist/gridstack.css";
import {
  GRID_CELL_HEIGHT,
  GRID_COLUMNS,
  GRID_MARGIN,
  type TileLayout,
  type TileView,
} from "../model";
import styles from "./GridStackBoard.module.css";

/**
 * The board grid, on gridstack.js.
 *
 * gridstack owns the hard parts a board needs and a plain CSS grid does not:
 * drag-to-reorder, two-axis resize (width AND height, from the tile's edge
 * handles), free 2D placement, and the animated reflow when one tile shoves the
 * others. It replaces the app's former hand-rolled width-only resize and the
 * FLIP reorder hook.
 *
 * REACT + GRIDSTACK OWNERSHIP. gridstack mutates the DOM directly — it sets each
 * item's position and size as inline style and writes gs-* attributes back on a
 * drag. React must not fight it. The rule that keeps the two apart:
 *
 *   - React renders the item WRAPPERS (`.grid-stack-item`) and their content,
 *     and sets each tile's geometry as gs-* attributes ONCE, from server state.
 *   - We never pass an inline `style` to a wrapper, so React never touches the
 *     position/size gridstack writes there.
 *   - The gs-* attribute VALUES are derived from `tile.geometry`, which only
 *     changes on a real server refresh — so React's attribute diff is a no-op on
 *     every content re-render (a poll, a load landing), and gridstack's own
 *     writes survive untouched.
 *   - The grid is re-initialised ONLY when the set of tile ids changes (a tile
 *     added or removed). A resize, a reorder, an edit or a poll never tears it
 *     down under the user. `destroy(false)` keeps the DOM so React's elements —
 *     and the ECharts inside them — are never unmounted.
 *
 * PERSISTENCE. On gridstack's `change` (fired once per settled gesture, with the
 * whole reflowed set), we serialise every node's id + x/y/w/h and hand it up to
 * be saved. We do NOT trigger a router refresh from here: gridstack already
 * shows the settled layout, and the page is force-dynamic, so the next natural
 * load reads the saved geometry. Pushing an RSC re-render mid-drag would buy
 * nothing and risk a flicker. See BoardDetail for the debounce around the save.
 *
 * SSR. gridstack needs a real DOM box, so this is a client component and the
 * `init` runs in an effect — never on the server. The markup React renders is
 * inert `.grid-stack` / `.grid-stack-item` divs that hydrate identically.
 */

/**
 * The class the tile's drag grip carries. gridstack drags a tile only by an
 * element matching this — so clicking the tile's buttons, panning a chart or
 * dragging a resize handle never starts a reorder. TileCard puts it on the grip.
 */
export const GRID_DRAG_HANDLE = "gs-drag-handle";

export function GridStackBoard({
  tiles,
  renderTile,
  onLayoutChange,
  editing,
}: {
  tiles: TileView[];
  /** Draw one tile's card. The wrapper + gridstack chrome are added here. */
  renderTile: (tile: TileView) => ReactNode;
  /** Every tile's footprint after a settled drag or resize. */
  onLayoutChange: (items: TileLayout[]) => void;
  /**
   * Layout editing is on — tiles can be dragged and resized. Off (the default),
   * the grid is static: nothing moves under a stray click, and the whole board
   * reads as a fixed dashboard. Toggling this does NOT re-init the grid (which
   * would remount every tile and its ECharts); it flips gridstack's static flag
   * in place.
   */
  editing: boolean;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridStack | null>(null);

  // Read fresh inside gridstack's callback without re-arming the effect — the
  // handler prop identity churns every render, the grid must not.
  const changeRef = useRef(onLayoutChange);
  changeRef.current = onLayoutChange;

  // Read the current mode inside the init effect without making the grid
  // re-init when it flips — the separate effect below flips it in place.
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Re-init only when the tile SET changes. A content refresh (a poll, an edit
  // that keeps the same tiles) leaves this key untouched, so the grid is left
  // exactly as the user arranged it.
  const idKey = tiles.map((t) => t.id).join(",");

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const grid = GridStack.init(
      {
        column: GRID_COLUMNS,
        cellHeight: GRID_CELL_HEIGHT,
        margin: GRID_MARGIN,
        // Honour each tile's stored x/y exactly — do NOT pull tiles up to fill
        // gaps. A board is arranged by hand, so where the author drops a tile is
        // where it must be on the next load; float:false recompacted on every
        // init and quietly undid the arrangement, which read as "reorder didn't
        // save" even though the geometry was persisted.
        float: true,
        animate: true,
        // Start static unless editing; the effect below flips this in place so a
        // toggle never re-inits (which would remount every tile's ECharts).
        staticGrid: !editingRef.current,
        // Drag only by the grip; resize from the east, south and corner edges so
        // both width and height are adjustable.
        handle: `.${GRID_DRAG_HANDLE}`,
        resizable: { handles: "e, se, s" },
        // Collapse to a single column on a narrow viewport, so tiles stack and
        // stay legible instead of shrinking to unreadable slivers.
        columnOpts: {
          breakpointForWindow: true,
          breakpoints: [{ w: 720, c: 1 }],
        },
      },
      el,
    );
    // init returns null only if the element is already a grid — never here, on a
    // fresh mount — but the type admits it, so bail rather than assert.
    if (!grid) return;
    gridRef.current = grid;

    const persist = () => {
      const nodes = grid.save(false) as GridStackNode[];
      const items: TileLayout[] = [];
      for (const node of nodes) {
        // gs-id round-trips as the node id; anything without one isn't ours.
        if (typeof node.id !== "string") continue;
        items.push({
          tileId: node.id,
          x: node.x ?? 0,
          y: node.y ?? 0,
          w: node.w ?? 1,
          h: node.h ?? 1,
        });
      }
      if (items.length > 0) changeRef.current(items);
    };
    grid.on("change", persist);

    return () => {
      grid.off("change");
      gridRef.current = null;
      // removeDOM=false: React owns the item elements and their ECharts; only
      // gridstack's behaviour is torn down, so a re-init doesn't remount tiles.
      grid.destroy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // Flip static ⇆ interactive in place when the mode changes, WITHOUT re-init:
  // setStatic toggles drag/resize on the live grid, so the tiles (and their
  // ECharts) are never torn down. Re-running the init effect for this instead
  // would remount every tile.
  useEffect(() => {
    gridRef.current?.setStatic(!editing);
  }, [editing]);

  return (
    <div ref={elRef} className={`grid-stack ${styles.grid}`}>
      {tiles.map((tile) => {
        const g = tile.geometry;
        // gs-* attributes are gridstack's read at init. Width/height always; the
        // origin only when the tile has actually been placed, so an unplaced pin
        // is auto-flowed rather than pinned to 0,0. Typed loose and cast because
        // gs-* aren't in React's HTML attribute types — they pass through to the
        // DOM untouched, which is exactly what gridstack reads.
        const attrs: Record<string, string | number> = {
          "gs-id": tile.id,
          "gs-w": g.w,
          "gs-h": g.h,
        };
        if (g.x !== undefined) attrs["gs-x"] = g.x;
        if (g.y !== undefined) attrs["gs-y"] = g.y;

        return (
          <div
            key={tile.id}
            className="grid-stack-item"
            {...(attrs as unknown as HTMLAttributes<HTMLDivElement>)}
          >
            <div className={`grid-stack-item-content ${styles.itemContent}`}>
              {renderTile(tile)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

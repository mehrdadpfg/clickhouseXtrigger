"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { GridStack } from "gridstack";
import "gridstack/dist/gridstack.css";
import {
  GRID_CELL_HEIGHT,
  GRID_COLUMNS,
  GRID_MARGIN,
} from "@/components/boards/model";
import styles from "./StaticChartGrid.module.css";

/**
 * A read-only gridstack, used purely as a layout/packing engine.
 *
 * The interactive board (boards/BoardDetail/GridStackBoard) owns drag, two-axis
 * resize and free 2D placement. This does none of that. It is the same library
 * and the SAME twelve-column model — GRID_COLUMNS / GRID_CELL_HEIGHT / GRID_MARGIN
 * — so a chart tiled into a chat answer sizes and reads exactly as it would once
 * pinned to a dashboard. All it borrows is gridstack's auto-flow: hand it a set
 * of items with a per-kind footprint and NO x/y, and it packs them into a tidy
 * grid, filling each row before starting the next.
 *
 * WHY A SIBLING, NOT A FLAG ON THE BOARD GRID. The board grid is built around
 * being interactive — a drag handle, resize handles, a `change` handler that
 * persists geometry, a static⇆interactive toggle, breakpoint columns. Bolting a
 * "never interactive, never persists, no stored positions" mode onto it would
 * mean threading a dead branch through all of that. This is the read-only half
 * on its own terms: `staticGrid`, no handles, no persistence, no stored x/y.
 *
 * REACT + GRIDSTACK OWNERSHIP (as on the board): React renders the item wrappers
 * and their content and sets each item's SIZE as gs-* attributes once; gridstack
 * owns POSITION. We pass no x/y, so gridstack auto-places. The grid is init'd once
 * per item SET (its `idKey`) and torn down with `destroy(false)`, which leaves
 * React's elements — and the ECharts inside them — mounted, so nothing remounts.
 *
 * STREAMING. The chat only renders artifacts once the turn is COMPLETE (see
 * AgentTurn's `isAnswerComplete` gate), so the whole set of charts is known when
 * this mounts. There is no mid-stream add to thrash the layout or remount a
 * chart: the grid is laid out once, on complete, from a stable set.
 *
 * SSR. gridstack needs a real DOM box, so this is a client component and the init
 * runs in an effect, never on the server. The markup React renders is inert
 * `.grid-stack` / `.grid-stack-item` divs that hydrate identically; gridstack v13
 * has no findDOMNode, so it is React-19-safe.
 */

/** One tile to place: a stable id, its grid footprint, and its rendered card. */
export interface StaticGridItem {
  /** gridstack's node id — also React's key. Stable across re-renders. */
  id: string;
  /** Columns occupied, 1..GRID_COLUMNS. */
  w: number;
  /** Rows occupied; each row is GRID_CELL_HEIGHT px. */
  h: number;
  content: ReactNode;
}

export function StaticChartGrid({ items }: { items: StaticGridItem[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridStack | null>(null);

  // Re-init only when the item SET changes. In the chat this is once (the set is
  // known when the completed turn mounts), but keying it means a later edit that
  // swaps a chart still re-flows rather than leaving a stale grid.
  const idKey = items.map((it) => it.id).join(",");

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const grid = GridStack.init(
      {
        column: GRID_COLUMNS,
        cellHeight: GRID_CELL_HEIGHT,
        margin: GRID_MARGIN,
        // The whole point: read-only. `staticGrid` turns off drag, resize and
        // reorder in one flag — this grid packs and is never touched.
        staticGrid: true,
        // Belt-and-braces alongside staticGrid, so no handle is ever attached.
        disableDrag: true,
        disableResize: true,
        // No stored positions, so pack tightly toward the top-left instead of
        // honouring x/y (which is what a board does). float:false is what makes
        // the auto-flow fill each row before the next rather than leave gaps.
        float: false,
        // A packing pass, not a live board — no need to animate tiles into place.
        animate: false,
        // Collapse to a single column when the grid box itself gets narrow, so
        // tiles stack and stay legible rather than shrinking to slivers. Keyed on
        // the grid's own width (breakpointForWindow:false), not the window, since
        // this sits in the chat's fixed reading column, not a full-width page.
        columnOpts: {
          breakpointForWindow: false,
          breakpoints: [{ w: 560, c: 1 }],
        },
      },
      el,
    );
    // init returns null only if the element is already a grid — never on a fresh
    // mount — but the type admits it, so bail rather than assert.
    if (!grid) return;
    gridRef.current = grid;

    return () => {
      gridRef.current = null;
      // removeDOM=false: React owns the item elements and their ECharts; only
      // gridstack's behaviour is torn down, so a re-init never remounts a chart.
      grid.destroy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  return (
    <div ref={elRef} className={`grid-stack ${styles.grid}`}>
      {items.map((item) => {
        // gs-w / gs-h are gridstack's read at init; NO gs-x / gs-y, so gridstack
        // auto-places each item. Typed loose and cast because gs-* aren't in
        // React's HTML attribute types — they pass through to the DOM untouched,
        // which is exactly what gridstack reads.
        const attrs: Record<string, string | number> = {
          "gs-id": item.id,
          "gs-w": item.w,
          "gs-h": item.h,
        };
        return (
          <div
            key={item.id}
            className="grid-stack-item"
            {...(attrs as unknown as HTMLAttributes<HTMLDivElement>)}
          >
            <div className="grid-stack-item-content">{item.content}</div>
          </div>
        );
      })}
    </div>
  );
}

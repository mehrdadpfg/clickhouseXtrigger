"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import {
  asChartSpec,
  Button,
  Card,
  EChart,
  ExportMenu,
  inferChartSpec,
  optionFromSpec,
  slugify,
  type EChartHandle,
} from "@/components/ui";
import type { EChartsCoreOption } from "echarts";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Spinner } from "@/components/ui/Spinner";
import { StatTile } from "@/components/ui/StatTile";
import { ChartTypeMenu, recast, TABLE_VIEW } from "@/components/shared/ChartType";
import {
  clampSpan,
  formatCell,
  GRID_COLUMNS,
  toKpi,
  toTable,
  type BoardActions,
  type ResultRow,
  type TileView,
} from "../model";
import styles from "./TileCard.module.css";
import { Tooltip } from "@/components/ui";

/**
 * One tile, run live.
 *
 * A tile stores SQL, not a snapshot — but it no longer fetches its own rows.
 * BoardDetail runs the whole board in one call and hands each tile its result,
 * because Next serialises server-action POSTs and N tiles asking separately is
 * an N-long chain of round trips (see BoardDetail). What is left here is the
 * shaping, done with the model's total functions: every render decision is made
 * from the result, never from a table name, which is what lets a board point at
 * any dataset.
 */
export type TileLoad =
  | { status: "loading" }
  | { status: "error"; error: string }
  /**
   * `staleError` means the LAST run failed while these rows are the last that
   * succeeded. It is a distinct state from `error`, not a nicety: on a board
   * that polls, a transient failure would otherwise replace nine good tiles'
   * numbers with nine copies of the same message, and the reader would lose the
   * data to the notification about the data. Rows on screen, failure stated.
   */
  | { status: "ready"; rows: ResultRow[]; staleError?: string };

const COUNT = new Intl.NumberFormat("en-US");

/** Drag-and-drop wiring passed down from the board so tiles can be reordered. */
export interface TileDnd {
  dragging: boolean;
  onGripDragStart: (e: DragEvent) => void;
  onGripDragEnd: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export function TileCard({
  tile,
  actions,
  load,
  busy,
  onRefresh,
  onEdit,
  dnd,
}: {
  tile: TileView;
  actions: BoardActions;
  /** This tile's result, owned by the board. */
  load: TileLoad;
  /** A run is in flight for this tile. `load` still holds the last good rows. */
  busy: boolean;
  onRefresh: () => void;
  /**
   * Ask the board to open its edit panel on this tile. The editing surface lives
   * once at the board level (a push panel that shrinks the grid), not per tile, so
   * the tile only raises the intent rather than owning the editor.
   */
  onEdit: () => void;
  dnd?: TileDnd;
}) {
  const router = useRouter();
  const [, startResize] = useTransition();
  const [, startRecast] = useTransition();
  const chartRef = useRef<EChartHandle>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  /**
   * The reader's chart-type pick, held here rather than read back off the tile.
   *
   * Recasting bar → line changes how one tile draws and nothing about what its
   * SQL returns, so it deliberately does NOT call router.refresh(): a refresh
   * re-renders the board, which bumps the load key and re-runs all ten queries
   * for a repaint. The write still goes to the server; this state is what the
   * tile renders until the next server render arrives with the same value
   * already in `tile.spec`, at which point the two agree and it is inert.
   */
  const [pickedType, setPickedType] = useState<string | null>(null);
  const [recastError, setRecastError] = useState<string | null>(null);

  const readyRows = load.status === "ready" ? load.rows : null;

  /**
   * The chart this tile is drawn from, before the reader's pick: its flint spec
   * and the ECharts option compiled from it.
   *
   * A tile pinned from a chat answer carries a spec (chartType + encodings); a
   * tile made by hand has none, so we infer one from the result's shape. A
   * stored spec can also go stale — rename a column upstream and its encodings
   * point at fields the rows no longer have — so a spec that produces no option
   * falls back to inference too. Without that fallback a rename turns the tile
   * permanently into "No data." with no way back short of re-pinning.
   *
   * Spec and option are memoized as a PAIR because the staleness test is
   * `optionFromSpec(stored) !== null` — compile it to decide, then throw the
   * result away and compile again below, and every board render pays for the
   * same object graph twice. Building it in the render path at all is what made
   * dragging churn, so once is the budget.
   *
   * This lives here rather than in TileBody because the header's type menu
   * needs the spec too: it is what a pick is recast FROM, and the row count
   * decides whether a pie is even offered.
   */
  const chart = useMemo(() => {
    if (!readyRows || tile.kind !== "chart") return null;
    const stored = tile.spec.chartType
      ? asChartSpec({ ...tile.spec, title: tile.title, data: readyRows })
      : null;
    const storedOption = stored ? optionFromSpec(stored) : null;
    if (stored && storedOption) return { spec: stored, option: storedOption };
    const inferred = inferChartSpec(readyRows, tile.title);
    if (!inferred) return null;
    return { spec: inferred, option: optionFromSpec(inferred) };
  }, [readyRows, tile.kind, tile.spec, tile.title]);

  const shown = useMemo(() => {
    if (!chart || !pickedType || pickedType === chart.spec.chartType)
      return chart;
    const spec = recast(chart.spec, pickedType);
    return { spec, option: optionFromSpec(spec) };
  }, [chart, pickedType]);

  const onPickType = (type: string) => {
    if (!chart) return;
    setRecastError(null);

    // Table is not a chart family — flint compiles no spec for it and the write
    // path rejects the sentinel outright. It is a tile KIND, and changing kind
    // swaps the renderer, so this one does want the server render back.
    if (type === TABLE_VIEW) {
      startRecast(async () => {
        const result = await actions.updateTile({
          tileId: tile.id,
          kind: "table",
        });
        if (result.ok) router.refresh();
        else setRecastError(result.error);
      });
      return;
    }

    // Guarded exactly as `shown` guards the render, and for the same reason:
    // recast() re-emits only x/y/color, so recasting a spec to the type it
    // already has would quietly drop every other channel it carries. Picking
    // the already-checked radio item still writes — an inferred spec has never
    // been persisted, and this is what pins it — but it writes the spec as it
    // stands rather than a lossy rebuild of it.
    const next =
      type === chart.spec.chartType ? chart.spec : recast(chart.spec, type);
    const previous = pickedType;
    setPickedType(type);
    startRecast(async () => {
      // chartType and encodings travel together: the type names the family, the
      // encodings say which column feeds which channel, and the action refuses
      // the first without the second.
      const result = await actions.updateTile({
        tileId: tile.id,
        chartType: next.chartType,
        encodings: next.encodings,
        ...(next.horizontal !== undefined
          ? { horizontal: next.horizontal }
          : {}),
      });
      if (!result.ok) {
        // Put the chart back to what is actually stored. Leaving the optimistic
        // type on screen would show a recast that no reload will reproduce.
        setPickedType(previous);
        setRecastError(result.error);
      }
    });
  };

  // --- resize --------------------------------------------------------------

  /**
   * The width the drag is showing, or null when the stored width is the truth.
   *
   * Held past the commit rather than cleared on pointer-up. The write is a POST
   * plus a router refresh, and dropping the preview at pointer-up means the
   * tile snaps back to its old width for that round trip and then forward
   * again — a visible bounce on every resize. So the preview stands until the
   * server render arrives carrying the same span, at which point the two agree
   * and the effect below retires it. Same shape as `pickedType` above, for the
   * same reason.
   */
  const [dragSpan, setDragSpan] = useState<number | null>(null);
  /**
   * Whether a resize gesture is in progress.
   *
   * Separate from `dragSpan` because that answers a different question. The
   * drag opens by seeding dragSpan with the tile's CURRENT span, which the
   * retire effect below immediately recognises as "the server caught up" and
   * clears — so the drag styling vanished one paint after pointerdown, and
   * again every time the cursor passed back through the tile's stored width.
   * The gesture's lifetime is bounded by pointer capture, not by whether the
   * preview happens to differ from what is saved.
   */
  const [resizing, setResizing] = useState(false);
  const [resizeError, setResizeError] = useState<string | null>(null);
  const shownSpan = dragSpan ?? tile.span;

  useEffect(() => {
    if (dragSpan !== null && tile.span === dragSpan) setDragSpan(null);
  }, [tile.span, dragSpan]);

  /**
   * Which grid width the cursor is currently over.
   *
   * Both halves of this are measured on every move, and that is the whole
   * trick. The obvious implementation — remember the pointer's x and the tile's
   * width at pointerdown, then add the delta — desyncs the moment the drag
   * changes which ROW the tile lands on: widening a tile can push it past the
   * end of its row, auto-placement wraps it, and its own left edge jumps a
   * whole grid width while the cursor has not moved. A remembered origin then
   * describes a tile that is no longer there, and the handle runs away from the
   * pointer. Reading the live rect instead means the origin is wherever the
   * tile actually is, so the wrap costs one frame of jump and nothing after it.
   *
   * The pitch is derived from the grid's measured width rather than assumed:
   * a span-N tile covers N columns and the N-1 gaps between them, so
   * N = (width + gap) / (column + gap), and (column + gap) collapses to
   * (gridWidth + gap) / GRID_COLUMNS.
   */
  const spanAt = (clientX: number): number | null => {
    const tileEl = tileRef.current;
    const grid = tileEl?.parentElement;
    if (!tileEl || !grid) return null;
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    const pitch = (grid.getBoundingClientRect().width + gap) / GRID_COLUMNS;
    if (!(pitch > 0)) return null;
    const left = tileEl.getBoundingClientRect().left;
    return clampSpan((clientX - left + gap) / pitch);
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Secondary buttons open context menus; they must not start a drag that
    // only ever ends on lostpointercapture.
    if (e.button !== 0 || !tileRef.current?.parentElement) return;
    // Suppresses the text selection a drag across the header would otherwise
    // start, which on touch also blocks the long-press callout.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizeError(null);
    setResizing(true);
    setDragSpan(tile.span);
  };

  // Capture is the authority on whether a drag is live, rather than a separate
  // flag: `dragSpan` stays set after the commit while the write is in flight,
  // so it cannot answer this question, and the browser releases capture on
  // exactly the events (pointerup, cancel, node removal) that end a drag.
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const next = spanAt(e.clientX);
    if (next !== null) setDragSpan(next);
  };

  /**
   * Committed on lostpointercapture, not pointerup: capture is also lost to a
   * cancelled gesture or to the node going away mid-drag, and those have to
   * settle the preview too or the tile keeps a width nothing will ever confirm.
   */
  const onResizeEnd = () => {
    if (dragSpan === null || dragSpan === tile.span) {
      setResizing(false);
      setDragSpan(null);
      return;
    }
    const next = dragSpan;
    startResize(async () => {
      const result = await actions.updateTile({ tileId: tile.id, span: next });
      if (result.ok) router.refresh();
      else {
        // Drop back to the stored width. Leaving the preview up would promise a
        // layout the next reload does not reproduce.
        setResizing(false);
      setDragSpan(null);
        setResizeError(result.error);
      }
    });
  };

  return (
    <Card
      ref={tileRef}
      role="region"
      padding="none"
      clip
      className={`${styles.tile} ${dnd?.dragging ? styles.dragging : ""} ${
        resizing ? styles.resizingNow : ""
      }`}
      style={{ gridColumn: `span ${shownSpan}` }}
      aria-label={tile.title}
      aria-busy={busy}
      {...(dnd ? { onDragOver: dnd.onDragOver, onDrop: dnd.onDrop } : {})}
    >
      <header className={styles.head}>
        {/* Drag handle: only the grip is draggable, so clicking the tile's
            buttons and panning a chart don't start a reorder. */}
        {dnd ? (
          <Tooltip label="Drag to reorder">
            <span
              className={styles.grip}
              draggable
              onDragStart={dnd.onGripDragStart}
              onDragEnd={dnd.onGripDragEnd}
              role="button"
              aria-label="Drag to reorder tile"
            >
              ⠿
            </span>
          </Tooltip>
        ) : null}
        {/* Every tile — KPI included — names itself in the header, at the top of
            the card. The KPI's number below is drawn without its own label so the
            name isn't printed twice. */}
        <span className={styles.title}>{tile.title}</span>
        {/* One row, pushed right as a group. The chart-type control is a menu
            and so arrives inside its own positioning wrapper rather than as a
            bare button, which a `first-of-type` margin on the buttons could not
            have reached. */}
        <div className={styles.tools}>
          {/* Recasting is offered only once the tile has rows: the menu needs a
            spec to recast FROM, and the row count decides whether a pie is a
            defensible option for this result. */}
          {chart && shown ? (
            <ChartTypeMenu
              current={shown.spec.chartType}
              allowPie={chart.spec.data.length <= 12}
              onPick={onPickType}
              {...(tile.spec.chartType
                ? { originalType: tile.spec.chartType }
                : {})}
              triggerClassName={styles.action}
            />
          ) : null}
          {/* Edit opens the ChartStudio, where the tile's query, chart, width and
            its Delete now all live. */}
          <Tooltip label="Edit">
            <button
              type="button"
              className={styles.action}
              onClick={onEdit}
              aria-label="Edit tile"
            >
              ✎
            </button>
          </Tooltip>
          {/* Chart tiles can be saved as an image; KPI/table tiles have no figure
            to export, so the control only rides along with a chart. */}
          {tile.kind === "chart" ? (
            <ExportMenu
              chartRef={chartRef}
              filename={slugify(tile.title)}
              buttonClassName={styles.action}
            />
          ) : null}
        </div>
      </header>

      {/* A failed recast or resize reverts the tile, so without this the only
          evidence would be it changing back — which reads as a misclick. */}
      {recastError || resizeError ? (
        <p className={styles.recastError} role="alert">
          {recastError || resizeError}
        </p>
      ) : null}

      {/* The numbers below are real, they are just not the newest ones — so
          this says so instead of throwing them away. Without it the tile would
          be indistinguishable from one that refreshed cleanly, which on a
          polling board is the one failure mode that matters. */}
      {load.status === "ready" && load.staleError ? (
        <p className={styles.stale} role="status">
          <strong className={styles.staleMark}>Not refreshed</strong>
          {/* Three lines rather than one sentence: the middle one is a
              ClickHouse message, which has its own punctuation and no reason to
              read as a clause of ours. */}
          <span>{load.staleError}</span>
          <span className={styles.staleNote}>
            Showing the last successful run.
          </span>
        </p>
      ) : null}

      <div className={styles.body}>
        <TileBody
          tile={tile}
          load={load}
          chartOption={shown?.option ?? null}
          chartRef={chartRef}
          onRetry={onRefresh}
          busy={busy}
        />
      </div>

      {/* The resize handle: a strip on the tile's trailing edge, pointer-driven.
          Deliberately NOT HTML5 drag-and-drop like the reorder grip above —
          dragstart/dragover give coarse, throttled coordinates that are fine for
          "which tile am I over" and useless for a continuous width.

          aria-hidden because there is nothing here for a keyboard to do: the
          equivalent control is the edit modal's Width field, which states the
          current width and sets it exactly. A drag strip that announced itself
          but could not be operated would be worse than silent. */}
      <div
        aria-hidden="true"
        className={styles.resizer}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onLostPointerCapture={onResizeEnd}
      >
        <span className={styles.resizerGrip} />
      </div>
    </Card>
  );
}

function TileBody({
  tile,
  load,
  chartOption,
  chartRef,
  onRetry,
  busy,
}: {
  tile: TileView;
  load: TileLoad;
  /**
   * Resolved and memoized by TileCard, which owns it because the header's type
   * menu reads the same spec. Null for a non-chart tile, and for a chart whose
   * rows compile to nothing.
   */
  chartOption: EChartsCoreOption | null;
  chartRef: RefObject<EChartHandle | null>;
  onRetry: () => void;
  busy: boolean;
}) {
  if (load.status === "loading") {
    return (
      <div className={styles.center}>
        <Spinner label="running…" />
      </div>
    );
  }

  if (load.status === "error") {
    // A failed tile used to be a dead end: the header ⟳ was the only way out and
    // nothing in the error said so. Most of what lands here is transient — a
    // timeout, a restarted dev server, a board-wide POST that never arrived — so
    // the retry belongs next to the message that reports it.
    return (
      <div className={styles.errorBox} role="alert">
        <p className={styles.errorText}>{load.error}</p>
        <Button
          variant="ghost"
          size="sm"
          icon="⟳"
          onClick={onRetry}
          disabled={busy}
        >
          {busy ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  const { rows } = load;

  if (tile.kind === "kpi") {
    const kpi = toKpi(rows, tile.spec, tile.title);
    if (!kpi) return <Empty />;
    // No label — the tile's title in the header already names it.
    return (
      <StatTile
        value={kpi.value}
        {...(kpi.delta ? { delta: kpi.delta } : {})}
      />
    );
  }

  if (tile.kind === "chart") {
    // Every chart renders through flint/ECharts — the same engine as the chat,
    // so the board and the thread agree. See chartOption above for how the
    // option is chosen.
    if (!chartOption) return <Empty />;
    return <EChart ref={chartRef} option={chartOption} height={160} />;
  }

  const table = toTable(rows, tile.spec);
  if (table.rows.length === 0) return <Empty />;
  const columns: DataColumn[] = table.columns.map((key) => ({
    key,
    label: key,
    format: (value: unknown) => formatCell(value),
  }));
  return (
    <DataTable
      columns={columns}
      rows={table.rows}
      maxHeight="240px"
      footer={
        <span>
          {table.total > table.rows.length
            ? `${COUNT.format(table.rows.length)} of ${COUNT.format(table.total)} rows`
            : `${COUNT.format(table.total)} row${table.total === 1 ? "" : "s"}`}
        </span>
      }
    />
  );
}

function Empty() {
  return <p className={styles.muted}>No data.</p>;
}

"use client";

import {
  useMemo,
  useRef,
  useState,
  useTransition,
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
  formatCell,
  toKpi,
  toTable,
  type BoardActions,
  type ResultRow,
  type TileView,
} from "../model";
import { GRID_DRAG_HANDLE } from "../BoardDetail/GridStackBoard";
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

export function TileCard({
  tile,
  actions,
  load,
  busy,
  onRefresh,
  onEdit,
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
}) {
  const router = useRouter();
  const [, startRecast] = useTransition();
  const chartRef = useRef<EChartHandle>(null);

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

  return (
    <Card
      role="region"
      padding="none"
      clip
      className={`${styles.tile}`}
      aria-label={tile.title}
      aria-busy={busy}
    >
      <header className={styles.head}>
        {/* Drag handle: gridstack drags a tile only by this grip (its `handle`
            selector is GRID_DRAG_HANDLE), so clicking the tile's buttons or
            panning a chart never starts a reorder. */}
        <Tooltip label="Drag to reorder">
          <span
            className={`${styles.grip} ${GRID_DRAG_HANDLE}`}
            role="button"
            aria-label="Drag to reorder tile"
          >
            ⠿
          </span>
        </Tooltip>
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

      {/* A failed recast reverts the tile, so without this the only evidence
          would be it changing back — which reads as a misclick. */}
      {recastError ? (
        <p className={styles.recastError} role="alert">
          {recastError}
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

      {/* The tile fills its gridstack cell (styles.body flexes to fill), so a
          chart inside sizes to the tile's height — see TileBody. Width and height
          are resized from gridstack's own edge/corner handles, not a strip here. */}
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
    // option is chosen. The chart FILLS the tile (height 100%) rather than a
    // fixed strip: the tile's height is the gridstack cell it was sized to, so a
    // chart pinned from chat lands at a sensible aspect and grows when the tile
    // is dragged taller. ECharts' own ResizeObserver tracks the box.
    if (!chartOption) return <Empty />;
    return <EChart ref={chartRef} option={chartOption} height="100%" />;
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

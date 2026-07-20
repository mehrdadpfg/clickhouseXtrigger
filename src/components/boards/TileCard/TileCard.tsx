"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import {
  asChartSpec,
  Card,
  Chip,
  EChart,
  ExportMenu,
  inferChartSpec,
  optionFromSpec,
  slugify,
  type EChartHandle,
} from "@/components/ui";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Spinner } from "@/components/ui/Spinner";
import { StatTile } from "@/components/ui/StatTile";
import {
  formatCell,
  GRID_COLUMNS,
  toKpi,
  toTable,
  type BoardActions,
  type ResultRow,
  type TileView,
} from "../model";
import { EditTileModal } from "./EditTileModal";
import styles from "./TileCard.module.css";
import { Tooltip } from "@/components/ui";

/**
 * One tile, run live.
 *
 * A tile stores SQL, not a snapshot — so this island runs it on mount (by id,
 * through the `run` action; the SQL never leaves the server) and shapes the
 * rows with the model's total functions. Every render decision is made from the
 * result, never from a table name, which is what lets a board point at any
 * dataset.
 */
type Load =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; rows: ResultRow[] };

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
  dnd,
}: {
  tile: TileView;
  actions: BoardActions;
  dnd?: TileDnd;
}) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [removing, startRemove] = useTransition();
  const [resizing, startResize] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const chartRef = useRef<EChartHandle>(null);

  const run = useCallback(async () => {
    setLoad({ status: "loading" });
    const result = await actions.run(tile.id);
    setLoad(
      result.ok
        ? { status: "ready", rows: result.rows }
        : { status: "error", error: result.error },
    );
  }, [actions, tile.id]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await actions.run(tile.id);
      if (!live) return;
      setLoad(
        result.ok
          ? { status: "ready", rows: result.rows }
          : { status: "error", error: result.error },
      );
    })();
    return () => {
      live = false;
    };
  }, [actions, tile.id]);

  const onRemove = () => {
    startRemove(async () => {
      const result = await actions.removeTile(tile.id);
      if (result.ok) router.refresh();
    });
  };

  // Resize by cycling the tile's grid width 1 → GRID_COLUMNS → 1. A quick,
  // no-modal way to widen or shrink a tile; the width persists in its spec.
  const onResize = () => {
    const next = (tile.span % GRID_COLUMNS) + 1;
    startResize(async () => {
      const result = await actions.updateTile({ tileId: tile.id, span: next });
      if (result.ok) router.refresh();
    });
  };

  return (
    <Card
      role="region"
      padding="none"
      clip
      className={`${styles.tile} ${dnd?.dragging ? styles.dragging : ""}`}
      style={{ gridColumn: `span ${tile.span}` }}
      aria-label={tile.title}
      {...(dnd
        ? { onDragOver: dnd.onDragOver, onDrop: dnd.onDrop }
        : {})}
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
        <Chip className={styles.kind} label={tile.kind} />
        <Tooltip label={`Width ${tile.span}/${GRID_COLUMNS} — click to resize`}>
          <button
            type="button"
            className={styles.action}
            onClick={onResize}
            disabled={resizing}
            aria-label={`Resize tile — currently ${tile.span} of ${GRID_COLUMNS} columns`}
          >
            ⤢
          </button>
        </Tooltip>
        <Tooltip label="Edit">
          <button
            type="button"
            className={styles.action}
            onClick={() => setEditOpen(true)}
            aria-label="Edit tile"
          >
            ✎
          </button>
        </Tooltip>
        <Tooltip label="Refresh">
          <button
            type="button"
            className={styles.action}
            onClick={() => void run()}
            disabled={load.status === "loading"}
            aria-label="Refresh tile"
          >
            ⟳
          </button>
        </Tooltip>
        <Tooltip label="Remove">
          <button
            type="button"
            className={styles.action}
            onClick={onRemove}
            disabled={removing}
            aria-label="Remove tile"
          >
            ✕
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
      </header>

      <div className={styles.body}>
        <TileBody tile={tile} load={load} chartRef={chartRef} />
      </div>

      <EditTileModal
        tile={tile}
        actions={actions}
        open={editOpen}
        onClose={() => setEditOpen(false)}
      />
    </Card>
  );
}

function TileBody({
  tile,
  load,
  chartRef,
}: {
  tile: TileView;
  load: Load;
  chartRef: RefObject<EChartHandle | null>;
}) {
  const readyRows = load.status === "ready" ? load.rows : null;

  /**
   * The tile's ECharts option, built once per result rather than per render.
   *
   * Dragging re-renders the whole board on every dragover, and this is the one
   * place that rebuilt an entire option object graph in the render path — so it
   * is memoized, and it has to sit above the early returns because hooks can't
   * be conditional. The branches below only read it.
   *
   * A tile pinned from a chat answer carries a flint spec (chartType +
   * encodings); a tile made by hand has none, so we infer one from the result's
   * shape. A stored spec can also go stale — rename a column upstream and its
   * encodings point at fields the rows no longer have — so a spec that produces
   * no option falls back to inference too. Without that fallback a rename turns
   * the tile permanently into "No data." with no way back short of re-pinning.
   */
  const chartOption = useMemo(() => {
    if (!readyRows || tile.kind !== "chart") return null;
    const stored = tile.spec.chartType
      ? asChartSpec({ ...tile.spec, title: tile.title, data: readyRows })
      : null;
    const fromStored = stored ? optionFromSpec(stored) : null;
    if (fromStored) return fromStored;
    const inferred = inferChartSpec(readyRows, tile.title);
    return inferred ? optionFromSpec(inferred) : null;
  }, [readyRows, tile.kind, tile.spec, tile.title]);

  if (load.status === "loading") {
    return (
      <div className={styles.center}>
        <Spinner label="running…" />
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <p className={styles.error} role="alert">
        {load.error}
      </p>
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

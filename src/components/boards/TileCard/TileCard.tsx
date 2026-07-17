"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Chart } from "@/components/ui/Chart";
import { asChartSpec, Card, Chip, EChart, optionFromSpec } from "@/components/ui";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Spinner } from "@/components/ui/Spinner";
import { StatTile } from "@/components/ui/StatTile";
import {
  formatCell,
  formatMetric,
  toChart,
  toKpi,
  toTable,
  type BoardActions,
  type ResultRow,
  type TileView,
} from "../model";
import styles from "./TileCard.module.css";

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

export function TileCard({
  tile,
  actions,
}: {
  tile: TileView;
  actions: BoardActions;
}) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [removing, startRemove] = useTransition();

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

  return (
    <Card
      role="region"
      padding="none"
      clip
      className={styles.tile}
      style={{ gridColumn: `span ${tile.span}` }}
      aria-label={tile.title}
    >
      <header className={styles.head}>
        {/* A KPI's name is carried by the StatTile label below, so repeating it
            here would print the title twice. Chart and table tiles have no such
            label, so the header is where their name lives. */}
        {tile.kind === "kpi" ? null : (
          <span className={styles.title}>{tile.title}</span>
        )}
        <Chip className={styles.kind} label={tile.kind} />
        <button
          type="button"
          className={styles.action}
          onClick={() => void run()}
          disabled={load.status === "loading"}
          aria-label="Refresh tile"
          title="Refresh"
        >
          ⟳
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={onRemove}
          disabled={removing}
          aria-label="Remove tile"
          title="Remove"
        >
          ✕
        </button>
      </header>

      <div className={styles.body}>
        <TileBody tile={tile} load={load} />
      </div>
    </Card>
  );
}

function TileBody({ tile, load }: { tile: TileView; load: Load }) {
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
    return (
      <StatTile
        label={kpi.label}
        value={kpi.value}
        {...(kpi.delta ? { delta: kpi.delta } : {})}
      />
    );
  }

  if (tile.kind === "chart") {
    // A tile pinned from a chat answer carries a flint spec (chartType +
    // encodings); render it with the same engine as the chat so the board and
    // the thread agree. Older tiles have no chartType and fall through to the
    // legacy inline chart.
    const flint = asChartSpec({ ...tile.spec, title: tile.title, data: rows });
    if (flint) {
      const option = optionFromSpec(flint);
      if (option) return <EChart option={option} height={160} />;
    }

    const chart = toChart(rows, tile.spec);
    if (!chart) return <Empty />;
    const unit = chart.unit;
    return (
      <Chart
        kind={chart.kind}
        series={chart.series}
        title={tile.title}
        height={150}
        x={{ ...(chart.xLabel ? { label: chart.xLabel } : {}) }}
        y={{
          ...(chart.yLabel ? { label: chart.yLabel } : {}),
          format: (value: number) => formatMetric(value, unit),
        }}
      />
    );
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

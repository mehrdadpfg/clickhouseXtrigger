"use client";

import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import {
  asChartSpec,
  Badge,
  Card,
  EChart,
  ExportMenu,
  Markdown,
  optionFromSpec,
  slugify,
  SqlBlock,
  StatTile,
  type BadgeVariant,
  type EChartHandle,
} from "@/components/ui";
import { chartRowWidths, defaultTileSize } from "@/components/boards/model";
import { StaticChartGrid } from "./StaticChartGrid";
import { lensLabel } from "@/lib/analyst/lenses";
import type {
  AnalystReport,
  RecommendationCategory,
  ReportChart,
  ReportRecommendation,
  ReportStat,
} from "@/lib/analyst/report";
import styles from "./ReportArtifact.module.css";
import turn from "./AgentTurn.module.css";

/**
 * The deep-dive report, rendered inline in the chat turn.
 *
 * The orchestrator's `runDeepDive` tool returns an `AnalystReport` — the stable
 * interface the whole feature hangs off — and this reads it off the tool call
 * and renders it, reusing the chat's own renderers: StatTile for KPIs, the
 * EChart pipeline for charts, Markdown for prose, SqlBlock for proposed DDL. No
 * new chart engine, no new report page: the report is just another artifact
 * under the answer, so the logic can later surface anywhere without changing.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a runDeepDive result as a report, or null if it's an error / not one. */
export function readReport(result: unknown): AnalystReport | null {
  if (!isRecord(result)) return null;
  if (result["version"] !== 1) return null;
  if (!Array.isArray(result["charts"]) || !Array.isArray(result["recommendations"])) {
    return null;
  }
  return result as unknown as AnalystReport;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** A KPI number that fits its tile — compacts the big ones, keeps small exact. */
function compactStat(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  return NUMBER.format(value);
}

/** The number as it reads on the tile — '$' leads, '%' and '×' trail. */
function formatStat(stat: ReportStat): { value: string; unit?: string } {
  if (stat.unit === "%" || stat.unit === "×") {
    return { value: NUMBER.format(stat.value), unit: stat.unit };
  }
  if (stat.unit === "$") return { value: `$${compactStat(stat.value)}` };
  return { value: compactStat(stat.value) };
}

const IMPACT_VARIANT: Record<ReportRecommendation["impact"], BadgeVariant> = {
  CRITICAL: "critical",
  HIGH: "serious",
  MEDIUM: "warning",
  LOW: "neutral",
};

const CATEGORY_LABEL: Record<RecommendationCategory, string> = {
  materialized_view: "Materialized view",
  rollup: "Rollup",
  projection_index: "Projection / index",
  schema_type: "Column type",
  partitioning: "Partitioning",
  join_enrichment: "Join / enrichment",
  new_metric: "Metric to track",
  external: "External context",
};

/**
 * One chart tile — the EChart pipeline, without the workspace/watch coupling.
 *
 * `fill` is set when the tile sits in the multi-chart auto-layout grid: the Card
 * fills the gridstack cell and the chart flexes to it, matching the chat answer's
 * charts and a board's tiles. A lone report chart (`fill` false) keeps a fixed,
 * comfortable height at the full measure.
 */
function ReportChartTile({ chart, fill }: { chart: ReportChart; fill: boolean }) {
  const spec = useMemo(() => asChartSpec(chart), [chart]);
  const option = useMemo(() => (spec ? optionFromSpec(spec) : null), [spec]);
  const chartRef = useRef<EChartHandle>(null);

  if (!spec) return null;

  const height = fill ? "100%" : 300;

  return (
    <Card
      className={fill ? `${styles.chartCard} ${turn.chartTileFill}` : styles.chartCard}
    >
      {chart.title ? <div className={styles.chartTitle}>{chart.title}</div> : null}
      {option ? (
        <>
          <div className={turn.chartTools}>
            <ExportMenu
              chartRef={chartRef}
              filename={slugify(chart.title)}
              buttonClassName={turn.chartTool}
            />
          </div>
          <div className={fill ? turn.chartBody : undefined}>
            <EChart ref={chartRef} option={option} height={height} />
          </div>
        </>
      ) : (
        <p className={styles.empty}>Couldn&apos;t draw this chart.</p>
      )}
    </Card>
  );
}

/** One ranked recommendation card. */
function RecCard({ rec, rank }: { rec: ReportRecommendation; rank: number }) {
  const statements = rec.proposedSql.filter((s) => s.trim() !== "");
  return (
    <Card className={rec.exploratory ? styles.exploratory : undefined}>
      {/* Collapsed by default: the report leads with its charts, and the
          recommendations read as a scannable ranked list — title, impact,
          category on one line — that opens to the full rationale and proposed
          SQL only when the reader wants it. Keeps the text-to-visual balance
          from tipping into a wall of prose under the charts. */}
      <details className={styles.rec}>
        <summary className={styles.recHead}>
          <span className={styles.recRank}>{rank}.</span>
          <span className={styles.recTitle}>{rec.title}</span>
          <Badge variant={IMPACT_VARIANT[rec.impact]}>{rec.impact}</Badge>
          <span className={styles.recCategory}>
            {CATEGORY_LABEL[rec.category]} · {lensLabel(rec.lens)}
            {rec.exploratory ? " · exploratory" : ""}
          </span>
        </summary>
        <div className={styles.recBody}>
          <Markdown>{rec.rationale}</Markdown>
        </div>
        {rec.evidence ? (
          <p className={styles.recEvidence}>
            <strong>Evidence:</strong> {rec.evidence}
          </p>
        ) : null}
        {statements.length > 0 ? (
          <SqlBlock
            sql={statements.join(";\n\n")}
            summary={`Proposed SQL — ${statements.length} statement${statements.length === 1 ? "" : "s"} (shown, not run)`}
          />
        ) : null}
        {rec.exploratory ? (
          <p className={styles.exploratoryNote}>
            Exploratory — rests on external context, not the dataset alone.
          </p>
        ) : null}
      </details>
    </Card>
  );
}

/** The whole report. */
export function ReportArtifact({ report }: { report: AnalystReport }) {
  const stats = report.stats;
  const charts = report.charts;

  const sections: ReactNode[] = [];

  if (stats.length > 0) {
    sections.push(
      <div key="stats" className={turn.statGrid}>
        {stats.map((stat) => {
          const { value, unit } = formatStat(stat);
          return (
            <Card key={stat.id} padding="sm">
              <StatTile size="md" label={stat.label} value={value} {...(unit ? { unit } : {})} />
            </Card>
          );
        })}
      </div>,
    );
  }

  if (charts.length > 1) {
    // Two or more charts tile into the shared static auto-layout grid. Widths
    // are chosen to fill each row (chartRowWidths) rather than a fixed w:4, so a
    // count that isn't a multiple of three doesn't strand the last chart beside
    // an empty gap. Height stays the board's per-kind chart footprint.
    const widths = chartRowWidths(charts.length);
    const { w: fallbackW, h } = defaultTileSize("chart");
    sections.push(
      <StaticChartGrid
        key="charts"
        items={charts.map((chart, i) => ({
          id: chart.id,
          w: widths[i] ?? fallbackW,
          h,
          content: <ReportChartTile chart={chart} fill />,
        }))}
      />,
    );
  } else if (charts.length === 1) {
    sections.push(<ReportChartTile key="charts" chart={charts[0]!} fill={false} />);
  }

  const recsSection =
    report.recommendations.length > 0 ? (
      <div key="recs" className={styles.section}>
        <span className={styles.sectionTitle}>Recommendations</span>
        <div className={styles.recs}>
          {report.recommendations.map((rec, i) => (
            <RecCard key={rec.id} rec={rec} rank={i + 1} />
          ))}
        </div>
      </div>
    ) : null;

  // Lead with the visuals — the stat strip and the charts — then the written
  // synthesis, then the recommendations. A reader complained the report opened
  // with a wall of prose; the numbers and charts are the point, so they go
  // first and the overview reads as their caption rather than their preamble.
  return (
    <div className={styles.report}>
      <div className={styles.header}>
        <span className={styles.eyebrow}>Deep-dive analysis</span>
        <span className={styles.domain}>{report.domain}</span>
        <span className={styles.tables}>{report.tables.join(", ")}</span>
        {report.lenses.length > 0 ? (
          <div className={styles.lensRow}>
            {report.lenses.map((l) => (
              <Badge key={l.id} variant="neutral">
                {l.label}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {sections}

      {report.overview ? <Markdown>{report.overview}</Markdown> : null}

      {recsSection}
    </div>
  );
}

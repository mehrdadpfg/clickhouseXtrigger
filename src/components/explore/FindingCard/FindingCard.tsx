"use client";

import {
  asChartSpec,
  EChart,
  inferChartSpec,
  optionFromSpec,
  StatTile,
} from "@/components/ui";
import { toKpi } from "@/components/boards";
import type { EnrichedFinding } from "@/lib/discover/model";
import styles from "./FindingCard.module.css";

/**
 * One nominated finding, rendered as a card.
 *
 * The finding arrives self-contained — the signal, the one-sentence prose, and
 * the rows its SQL already produced — so this draws from data it holds and never
 * sends SQL. The viz reuses the chat/board chart pipeline: a flint spec when the
 * agent gave a chart type + encodings, an inferred one from the result shape
 * otherwise, and a stat tile for a single number. The four verbs ride every card
 * identically; they are wired in the next step.
 */

/** The four verbs — names still provisional (see the direction memo). */
const VERBS: readonly { key: string; label: string; glyph: string }[] = [
  { key: "why", label: "Why?", glyph: "?" },
  { key: "disagree", label: "Who disagrees?", glyph: "✓" },
  { key: "shape", label: "Same shape?", glyph: "≈" },
  { key: "weird", label: "What's weird?", glyph: "◎" },
];

function SurpriseMeter({ surprise }: { surprise: number }) {
  const level = Math.max(0, Math.min(4, Math.round(surprise)));
  return (
    <span className={styles.surprise} title={`surprise ${surprise.toFixed(1)}`}>
      <span className={styles.bars} aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <i
            key={i}
            className={i <= level ? styles.barOn : ""}
            style={{ height: `${3 + i * 2}px` }}
          />
        ))}
      </span>
      σ {surprise.toFixed(1)}
    </span>
  );
}

function FindingViz({ finding }: { finding: EnrichedFinding }) {
  if (finding.error) {
    return (
      <p className={styles.vizError} role="alert">
        couldn&rsquo;t run: {finding.error}
      </p>
    );
  }

  const rows = finding.rows;
  if (!rows || rows.length === 0) {
    return <p className={styles.muted}>No rows.</p>;
  }

  // Prefer the agent's chart type when it also gave encodings (asChartSpec needs
  // a non-empty map); otherwise infer the shape from the result.
  const enc =
    finding.encodings && Object.keys(finding.encodings).length > 0
      ? finding.encodings
      : null;
  const spec =
    enc && finding.chartType
      ? asChartSpec({
          chartType: finding.chartType,
          encodings: enc,
          title: finding.signal,
          data: rows,
        })
      : inferChartSpec(rows, finding.signal);

  const option = spec ? optionFromSpec(spec) : null;
  if (option) return <EChart option={option} height={150} />;

  // No chartable x/y pair — a single headline number reads best as a stat.
  const kpi = toKpi(rows, {}, finding.signal);
  if (kpi) return <StatTile value={kpi.value} />;

  return <p className={styles.muted}>—</p>;
}

export function FindingCard({ finding }: { finding: EnrichedFinding }) {
  const cross = finding.tables.length > 1;

  return (
    <article
      className={`${styles.card} ${cross ? styles.cross : ""}`}
      aria-label={finding.signal}
    >
      <div className={styles.head}>
        <span className={styles.signal}>
          {cross ? <span className={styles.crossTag}>cross-table</span> : null}
          {finding.signal}
        </span>
        <SurpriseMeter surprise={finding.surprise} />
      </div>

      <div className={styles.viz}>
        <FindingViz finding={finding} />
      </div>

      <p className={styles.finding}>{finding.finding}</p>

      {/* The four verbs — identical on every card. Inert until the verb step. */}
      <div className={styles.verbs}>
        {VERBS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={styles.verb}
            data-verb={v.key}
            title="coming next"
          >
            <span className={styles.verbGlyph} aria-hidden="true">
              {v.glyph}
            </span>{" "}
            {v.label}
          </button>
        ))}
      </div>
    </article>
  );
}

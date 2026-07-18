"use client";

import type { EnrichedFinding, VerbKey } from "@/lib/discover/model";
import { CardViz } from "../CardViz/CardViz";
import { VerbBar } from "../VerbBar/VerbBar";
import styles from "./FindingCard.module.css";

/**
 * One nominated finding, rendered as a card.
 *
 * The finding arrives self-contained — the signal, the one-sentence prose, and
 * the rows its SQL already produced — so the viz draws from data it holds (see
 * CardViz). The four verbs ride every card identically; clicking one grows a
 * child card in the walk (onVerb).
 */
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

export function FindingCard({
  finding,
  onVerb,
}: {
  finding: EnrichedFinding;
  onVerb: (verb: VerbKey) => void;
}) {
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
        <CardViz
          rows={finding.rows}
          error={finding.error}
          chartType={finding.chartType}
          encodings={finding.encodings}
          title={finding.signal}
        />
      </div>

      <p className={styles.finding}>{finding.finding}</p>

      <VerbBar onVerb={onVerb} />
    </article>
  );
}

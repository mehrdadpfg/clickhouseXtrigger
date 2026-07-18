"use client";

import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { Spinner } from "@/components/ui";
import type { VerbKey, VerbMetadata } from "@/lib/discover/model";
import { CardViz } from "../CardViz/CardViz";
import { VerbBar } from "../VerbBar/VerbBar";
import card from "../FindingCard/FindingCard.module.css";
import styles from "./WalkCard.module.css";

/** The source a verb runs against — a finding, or a prior walk step's child. */
export interface WalkSource {
  signal: string;
  finding: string;
  sql: string;
  chartType?: string;
  tables?: string[];
}

/** One live walk step: the run to watch + the breadcrumb that led here. */
export interface WalkEntry {
  runId: string;
  accessToken: string;
  verb: VerbKey;
  /** e.g. ["Concentration", "Why?"] — the path from a seed finding to here. */
  trail: string[];
}

const VERDICT_CLASS: Record<string, string | undefined> = {
  ok: styles.ok,
  soft: styles.soft,
  bad: styles.bad,
};

/**
 * One card in the walk. It subscribes to its verb run and renders whatever the
 * run's metadata reports: a computing state, then the child finding — the same
 * anatomy as a nominated card (signal, figure, one line) plus a breadcrumb trail
 * and, when the verb defines one, a verdict badge. Its own verb bar continues the
 * walk from here, so a walk can go arbitrarily deep with zero typing.
 */
export function WalkCard({
  entry,
  onContinue,
}: {
  entry: WalkEntry;
  onContinue: (source: WalkSource, verb: VerbKey, trail: string[]) => void;
}) {
  const { run, error: runError } = useRealtimeRun(entry.runId, {
    accessToken: entry.accessToken,
    enabled: true,
  });

  const meta = run?.metadata as VerbMetadata | undefined;
  const result = meta?.result ?? null;

  const failed =
    meta?.status === "failed" ||
    run?.status === "FAILED" ||
    run?.status === "CRASHED" ||
    run?.status === "TIMED_OUT";

  const trail = (
    <div className={styles.trail}>
      {entry.trail.map((step, i) => (
        <span key={i} className={styles.trailPart}>
          {i > 0 ? <span className={styles.trailArrow}>▸</span> : null}
          <span className={i === entry.trail.length - 1 ? styles.trailHere : ""}>
            {step}
          </span>
        </span>
      ))}
    </div>
  );

  if (failed) {
    return (
      <article className={`${card.card} ${styles.child}`}>
        {trail}
        <p className={card.vizError} role="alert">
          {meta?.error ??
            (runError instanceof Error ? runError.message : "That verb failed.")}
        </p>
      </article>
    );
  }

  if (!result) {
    return (
      <article className={`${card.card} ${styles.child}`}>
        {trail}
        <div className={styles.loading}>
          <Spinner label="" />
          <span className={styles.loadingNote}>
            {typeof meta?.probeCount === "number" && meta.probeCount > 0
              ? `looking at the data (${meta.probeCount})…`
              : "computing…"}
          </span>
        </div>
      </article>
    );
  }

  return (
    <article className={`${card.card} ${styles.child}`} aria-label={result.signal}>
      {trail}
      <div className={card.head}>
        <span className={card.signal}>{result.signal}</span>
        {result.verdict ? (
          <span
            className={`${styles.verdict} ${VERDICT_CLASS[result.verdict.tone] ?? ""}`}
            title={result.verdict.note ?? undefined}
          >
            {result.verdict.label}
          </span>
        ) : null}
      </div>

      <div className={card.viz}>
        <CardViz
          rows={result.rows}
          error={result.error}
          chartType={result.chartType}
          encodings={result.encodings}
          title={result.signal}
        />
      </div>

      <p className={card.finding}>{result.finding}</p>
      {result.verdict?.note ? (
        <p className={styles.verdictNote}>{result.verdict.note}</p>
      ) : null}

      <VerbBar
        onVerb={(verb) =>
          onContinue(
            {
              signal: result.signal,
              finding: result.finding,
              sql: result.sql,
              ...(result.chartType ? { chartType: result.chartType } : {}),
            },
            verb,
            entry.trail,
          )
        }
      />
    </article>
  );
}

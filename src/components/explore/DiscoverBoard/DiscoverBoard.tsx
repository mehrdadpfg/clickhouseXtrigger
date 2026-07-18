"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { Spinner } from "@/components/ui";
import { startDiscoveryAction } from "@/app/explore/actions";
// Type-only: keeps the server-only discovery task (and its ClickHouse client)
// out of this client bundle, exactly as CompareController does with its task.
import type {
  DiscoveryMetadata,
  EnrichedFinding,
} from "@/lib/discover/model";
import { FindingCard } from "../FindingCard/FindingCard";
import styles from "./DiscoverBoard.module.css";

/**
 * The live wiring behind the findings board.
 *
 * On mount it starts one durable discovery run over the curated scope, then
 * subscribes to that run and renders whatever its metadata reports: a probing
 * state while the agent works, the relationship map + finding cards once it
 * lands, or the error if it fails. Nothing here runs SQL — each finding arrives
 * with its rows already embedded by the task.
 */

interface Session {
  runId: string;
  accessToken: string;
}

function spanFor(finding: EnrichedFinding): 1 | 2 {
  if (finding.tables.length > 1) return 2; // cross-table earns the width
  const t = (finding.chartType ?? "").toLowerCase();
  if (/line|area|stream|heatmap|sankey|calendar/.test(t)) return 2;
  return 1;
}

export function DiscoverBoard({
  tables,
  focus,
}: {
  tables: string[];
  focus?: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const started = useRef(false);

  // Start exactly one run per mount. A reload is a fresh exploration.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startDiscoveryAction({ tables, focus }).then((res) => {
      if (res.ok) setSession({ runId: res.runId, accessToken: res.accessToken });
      else setStartError(res.error);
    });
  }, [tables, focus]);

  const { run, error: runError } = useRealtimeRun(session?.runId, {
    accessToken: session?.accessToken,
    enabled: !!session,
  });

  const meta = run?.metadata as DiscoveryMetadata | undefined;
  const result = meta?.result ?? null;

  const findings = useMemo(
    () => (result ? [...result.findings].sort((a, b) => b.surprise - a.surprise) : []),
    [result],
  );

  const failed =
    startError !== null ||
    meta?.status === "failed" ||
    run?.status === "FAILED" ||
    run?.status === "CRASHED" ||
    run?.status === "TIMED_OUT";

  const errorMessage =
    startError ??
    meta?.error ??
    (runError instanceof Error ? runError.message : null) ??
    "Discovery failed.";

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <span className={styles.eyebrow}>Vantage · discovery</span>
        <h1 className={styles.title}>
          {tables.length > 1
            ? `Connections across ${tables.length} tables`
            : "What's worth noticing"}
        </h1>
        <div className={styles.scope}>
          {tables.map((t) => (
            <span key={t} className={styles.scopeChip}>
              {t}
            </span>
          ))}
          <Link href="/explore" className={styles.change}>
            change scope
          </Link>
        </div>
        {focus ? (
          <p className={styles.focus}>
            Focus: <b>{focus}</b>
          </p>
        ) : null}
      </header>

      {failed ? (
        <div className={styles.state}>
          <p className={styles.stateError} role="alert">
            {errorMessage}
          </p>
          <Link href="/explore" className={styles.change}>
            ← try a different scope
          </Link>
        </div>
      ) : !result ? (
        <div className={styles.state}>
          <Spinner label="" />
          <p className={styles.stateTitle}>
            {tables.length > 1
              ? "Working out how these tables connect…"
              : "Profiling for what the data nominates…"}
          </p>
          <p className={styles.stateNote}>
            {typeof meta?.probeCount === "number" && meta.probeCount > 0
              ? `looked at the data ${meta.probeCount} time${meta.probeCount === 1 ? "" : "s"} so far`
              : "the agent is reading the schema"}
          </p>
        </div>
      ) : (
        <>
          {result.relationships.length > 0 ? (
            <section className={styles.rels} aria-label="How the tables relate">
              <span className={styles.relsLabel}>how they relate</span>
              <div className={styles.relsRow}>
                {result.relationships.map((r, i) => (
                  <span key={i} className={styles.rel}>
                    <span className={styles.relPair}>
                      {shortName(r.a)} <span className={styles.relArrow}>⇄</span>{" "}
                      {shortName(r.b)}
                    </span>
                    <span className={styles.relOn}>{r.on}</span>
                    <span
                      className={`${styles.relKind} ${styles[`conf_${r.confidence}`]}`}
                      title={r.rationale}
                    >
                      {r.kind} · {r.confidence}
                    </span>
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <div className={styles.board}>
            {findings.map((f) => (
              <div
                key={f.id}
                className={styles.cell}
                style={{ gridColumn: `span ${spanFor(f)}` }}
              >
                <FindingCard finding={f} />
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

/** "database.table" → "table" for the compact relationship chips. */
function shortName(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(dot + 1);
}

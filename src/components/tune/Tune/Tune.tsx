"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EvidencePanel } from "../EvidencePanel/EvidencePanel";
import { SuggestionCard } from "../SuggestionCard/SuggestionCard";
import type { TuneActions, TuneRunStatus, TuneView } from "../model";
import styles from "./Tune.module.css";

export interface TuneProps {
  initial: TuneView;
  actions: TuneActions;
}

/** The pre-prompted question the design opens with — the shape of what Tune answers. */
const OPENER =
  "Based on what I've been asking, what should I materialize in ClickHouse to make my dashboards faster?";

const ACTIVE: ReadonlySet<TuneRunStatus> = new Set([
  "analyzing",
  "proposing",
  "awaiting_approval",
]);

const RUNNING_LABEL: Partial<Record<TuneRunStatus, string>> = {
  analyzing: "Reading your query history…",
  proposing: "Working out what to materialize…",
  awaiting_approval: "Waiting on your approval…",
};

/**
 * The Optimize page. Triggers the tune run, live-polls its metadata while it is
 * working or awaiting approval, and turns each Approve into a server-side token
 * completion — the moment the real DDL is allowed to run.
 *
 * Polling (rather than a realtime socket) keeps every Trigger credential on the
 * server: the browser only ever calls the three server actions handed in as
 * props, and never sees a run token or a waitpoint id.
 */
export function Tune({ initial, actions }: TuneProps) {
  const [view, setView] = useState<TuneView>(initial);
  const [runId, setRunId] = useState<string | null>(initial.runId);
  const [starting, setStarting] = useState(false);
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // The latest runId, read inside the polling interval without re-subscribing.
  const runIdRef = useRef<string | null>(runId);
  runIdRef.current = runId;

  const refresh = useCallback(
    async (id?: string | null) => {
      try {
        const next = await actions.refresh(id ?? runIdRef.current ?? undefined);
        setView(next);
        if (next.runId) setRunId(next.runId);
      } catch {
        // A dropped poll is not worth surfacing — the next tick retries.
      }
    },
    [actions],
  );

  // Poll while the run is doing work or holding open for approval.
  useEffect(() => {
    if (!ACTIVE.has(view.runStatus)) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [view.runStatus, refresh]);

  // A card stays "Working…" from the click until the server reports the
  // suggestion left "pending" — the DDL can take a while to build.
  useEffect(() => {
    setDeciding((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const s of view.suggestions) {
        if (s.status !== "pending") next.delete(s.id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [view.suggestions]);

  const onStart = useCallback(async () => {
    setStarting(true);
    setError(null);
    const result = await actions.start();
    setStarting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRunId(result.runId);
    setView((v) => ({
      ...v,
      runId: result.runId,
      runStatus: "analyzing",
      finding: null,
      suggestions: [],
    }));
    void refresh(result.runId);
  }, [actions, refresh]);

  const onDecide = useCallback(
    async (id: string, approved: boolean) => {
      if (!runIdRef.current) return;
      setError(null);
      setDeciding((prev) => new Set(prev).add(id));
      const result = await actions.decide(runIdRef.current, id, approved);
      if (!result.ok && result.error) setError(result.error);
      await refresh();
    },
    [actions, refresh],
  );

  const running = ACTIVE.has(view.runStatus);
  const hasRun = view.runStatus !== "idle";

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <header className={styles.head}>
          <h1 className={styles.title}>Optimize</h1>
          <span className={styles.pill}>ClickHouse · trigger.dev</span>
          <div className={styles.headAction}>
            {running ? (
              <Spinner size="sm" label={RUNNING_LABEL[view.runStatus]} />
            ) : (
              <Button
                variant={hasRun ? "ghost" : "primary"}
                size="sm"
                onClick={onStart}
                disabled={starting}
              >
                {starting
                  ? "Starting…"
                  : hasRun
                    ? "Re-run analysis"
                    : "Run analysis"}
              </Button>
            )}
          </div>
        </header>

        <p className={styles.lede}>
          The agent reads your query history and proposes what to materialize so
          recurring questions and dashboards return faster. Nothing runs until
          you approve it.
        </p>

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        {/* The opening question, as the design frames it. */}
        <div className={styles.promptRow}>
          <div className={styles.prompt}>{OPENER}</div>
        </div>

        {/* The finding — the agent's answer over the whole history. */}
        <div className={styles.findingRow}>
          <span className={styles.avatar} aria-hidden="true">
            ◈
          </span>
          <div className={styles.findingBody}>
            <div className={styles.findingLabel}>
              {view.finding
                ? `Finding · from ${view.totalQueries.toLocaleString()} queries over ${view.windowDays} days`
                : "Finding"}
            </div>
            <p className={styles.findingText}>
              {view.finding ??
                (running
                  ? "Analysing your query history…"
                  : "Run an analysis and the agent will propose what to materialize, drawn from the query patterns on the right.")}
            </p>
          </div>
        </div>

        <div className={styles.grid}>
          <div className={styles.suggestions}>
            <div className={styles.sectionLabel}>Suggested optimizations</div>

            {view.suggestions.length === 0 ? (
              <div className={styles.emptySuggestions}>
                {running
                  ? "The agent is preparing suggestions…"
                  : hasRun
                    ? "No optimizations proposed for this window."
                    : "No suggestions yet — run an analysis to generate them."}
              </div>
            ) : (
              view.suggestions.map((s) => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  busy={deciding.has(s.id)}
                  onDecide={(approved) => onDecide(s.id, approved)}
                />
              ))
            )}
          </div>

          <EvidencePanel evidence={view.evidence} windowDays={view.windowDays} />
        </div>
      </div>
    </main>
  );
}

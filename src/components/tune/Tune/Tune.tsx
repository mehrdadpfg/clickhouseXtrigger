"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Chip, Spinner } from "@/components/ui";
import { EvidencePanel } from "../EvidencePanel/EvidencePanel";
import { FindingCard } from "../FindingCard/FindingCard";
import {
  groupByImpact,
  isDecidable,
  type Impact,
  type TuneActions,
  type TuneRunStatus,
  type TuneView,
} from "../model";

export interface TuneProps {
  initial: TuneView;
  actions: TuneActions;
}

const ACTIVE: ReadonlySet<TuneRunStatus> = new Set([
  "analyzing",
  "investigating",
  "proposing",
  "awaiting_approval",
]);

const RUNNING_LABEL: Partial<Record<TuneRunStatus, string>> = {
  analyzing: "Reading query history and table layout…",
  investigating: "Measuring what looks wrong…",
  proposing: "Writing up findings…",
  awaiting_approval: "Waiting on your approval…",
};

/** The impact heading's colour. Reserved status hues, each with its word. */
const IMPACT_CLASS: Record<Impact, string> = {
  CRITICAL: "text-[var(--critical)]",
  HIGH: "text-[var(--warning)]",
  MEDIUM: "text-muted-foreground",
};

/**
 * The Optimize page. Triggers the tune run, live-polls its metadata while it is
 * working or awaiting approval, and turns each Approve into a server-side token
 * completion — the moment the real DDL is allowed to run.
 *
 * Presented as a report rather than a conversation: findings are grouped by
 * impact, and each one states the measurement behind it. An earlier version
 * framed this as a chat, with a hardcoded opening question and an assistant
 * avatar, which promised a dialogue the page could not hold.
 *
 * Polling (rather than a realtime socket) keeps every Trigger credential on the
 * server: the browser only ever calls the three server actions handed in as
 * props, and never sees a run token or a waitpoint id.
 */
export function Tune({ initial, actions }: TuneProps) {
  const [view, setView] = useState<TuneView>(initial);
  const [runId, setRunId] = useState<string | null>(initial.runId);
  const [starting, setStarting] = useState(false);
  /** Which findings are ticked. Client state until Apply submits them all. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /**
   * Which approved MV findings the reader also wants backfilled. A separate set
   * from `selected` — approving the view and populating it are two decisions —
   * submitted together in the one Apply call.
   */
  const [backfill, setBackfill] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!ACTIVE.has(view.runStatus)) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [view.runStatus, refresh]);

  /**
   * Every appliable finding starts ticked when a report first arrives.
   *
   * Opt-out rather than opt-in: the agent already dropped what it could not
   * measure, so the default reads as "this is what I would do" — and the
   * reader unticks what they disagree with. Keyed on the id set, so a poll
   * that returns the same findings does not stamp over a reader's unticking
   * mid-review.
   */
  const pendingKey = view.findings
    .filter((f) => isDecidable(f.status))
    .map((f) => f.id)
    .join(",");

  useEffect(() => {
    setSelected(new Set(pendingKey ? pendingKey.split(",") : []));
    // Backfill is opt-in and heavy, so it does not inherit the tick-all default
    // — it starts empty and the reader turns it on per MV.
    setBackfill(new Set());
  }, [pendingKey]);

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
      findings: [],
    }));
    void refresh(result.runId);
  }, [actions, refresh]);

  const onToggle = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    // Unticking the view drops any backfill choice with it — there is nothing
    // to populate if the MV is not being created.
    if (!on) {
      setBackfill((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const onToggleBackfill = useCallback((id: string, on: boolean) => {
    setBackfill((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const onApply = useCallback(async () => {
    if (!runIdRef.current) return;
    setError(null);
    setApplying(true);
    const result = await actions.apply(
      runIdRef.current,
      [...selected],
      [...backfill],
    );
    if (!result.ok && result.error) setError(result.error);
    await refresh();
    setApplying(false);
  }, [actions, refresh, selected, backfill]);

  const groups = useMemo(() => groupByImpact(view.findings), [view.findings]);
  const running = ACTIVE.has(view.runStatus);
  const hasRun = view.runStatus !== "idle";

  const appliablePending = view.findings.filter((f) =>
    isDecidable(f.status),
  ).length;
  const advisory = view.findings.filter((f) => f.status === "advisory").length;
  /** The bar only exists while the run is actually parked on its token. */
  const awaitingApproval =
    view.runStatus === "awaiting_approval" && appliablePending > 0;

  /**
   * The subhead: what this report covers, in real numbers.
   *
   * The query window is described by what the log ACTUALLY held, not by the
   * window that was asked for. ClickHouse Cloud rotates system.query_log within
   * the hour, so "23 queries over 14 days" is a sentence that makes a busy
   * database look idle — the queries were real, the log just no longer has them.
   */
  const retained = view.retainedMinutes;
  const windowLabel =
    retained > 0 && retained < view.windowDays * 24 * 60
      ? retained >= 120
        ? `the last ${Math.round(retained / 60)}h of query log`
        : `the last ${retained}m of query log`
      : `${view.windowDays} days`;

  const scope = [
    view.findings.length > 0
      ? `${view.findings.length} finding${view.findings.length === 1 ? "" : "s"}`
      : null,
    view.tablesProfiled > 0 ? `${view.tablesProfiled} tables` : null,
    view.totalQueries > 0
      ? `${view.totalQueries.toLocaleString()} queries in ${windowLabel}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className="min-h-screen bg-background px-9 pb-20 pt-[30px] text-foreground max-[720px]:px-[18px] max-[720px]:pb-[60px] max-[720px]:pt-6">
      <div className="mx-auto max-w-[1080px]">
        <header className="mb-1 flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">
            Optimize
          </h1>
          <Chip label="ClickHouse · trigger.dev" />
          <div className="ml-auto flex items-center">
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

        <p className="m-0 mb-5 max-w-[80ch] text-[13px] leading-[1.5] text-muted-foreground">
          {scope ||
            "Reviews your query history and how your tables are physically stored, against ClickHouse best practices. Nothing is changed until you approve it."}
          {advisory > 0 ? (
            <>
              {" · "}
              <span className="text-[var(--warning)]">
                {advisory} need{advisory === 1 ? "s" : ""} a table rebuild
              </span>
            </>
          ) : null}
        </p>

        {error ? (
          <div
            role="alert"
            className="mb-[18px] rounded-[var(--r-md)] border border-[var(--critical-border)] bg-[var(--critical-bg)] px-[13px] py-2.5 text-[13px] leading-[1.5] text-[var(--critical)]"
          >
            {error}
          </div>
        ) : null}

        {/* The summary — the agent's read over the whole database. */}
        {view.finding || running ? (
          <Card padding="none" className="mb-6 px-[17px] py-[15px]">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--good)]">
              Summary
            </div>
            <p
              className={`m-0 max-w-[90ch] text-[13.5px] leading-[1.6] text-[var(--text)] [text-wrap:pretty] ${
                summaryOpen ? "" : "line-clamp-3"
              }`}
            >
              {view.finding ?? "Working through your schema and query history…"}
            </p>
            {view.finding && view.finding.length > 260 ? (
              <button
                type="button"
                onClick={() => setSummaryOpen((v) => !v)}
                className="mt-1.5 font-mono text-[10.5px] text-muted-foreground underline-offset-2 hover:text-[var(--text)] hover:underline"
              >
                {summaryOpen ? "less" : "more"}
              </button>
            ) : null}
          </Card>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start gap-6 max-[900px]:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-4">
            {groups.length === 0 ? (
              <Card
                padding="none"
                className="border-dashed px-4 py-5 text-[13px] leading-[1.5] text-muted-foreground"
              >
                {running
                  ? "The agent is working through your schema…"
                  : hasRun
                    ? "No findings — your schema looks reasonable for how it is being queried."
                    : "Run an analysis to review your schema and query history."}
              </Card>
            ) : (
              groups.map((group) => (
                <section key={group.impact} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-mono text-[10.5px] uppercase tracking-[0.08em] ${IMPACT_CLASS[group.impact]}`}
                    >
                      {group.impact}
                    </span>
                    <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {group.findings.length}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-px flex-1 bg-[var(--border-subtle)]"
                    />
                  </div>

                  {group.findings.map((f) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      selected={selected.has(f.id)}
                      backfillSelected={backfill.has(f.id)}
                      busy={applying}
                      onToggle={(on) => onToggle(f.id, on)}
                      onToggleBackfill={(on) => onToggleBackfill(f.id, on)}
                    />
                  ))}
                </section>
              ))
            )}
          </div>

          {/* Sticky: the report runs far longer than the evidence does, so a
              statically-placed panel would scroll away and leave the column
              empty for most of the page. */}
          <div className="sticky top-6 max-[900px]:static">
            <EvidencePanel
              evidence={view.evidence}
              windowDays={view.windowDays}
            />
          </div>
        </div>
      </div>

      {/* One decision for the whole report. Sticky, because the findings it
          commits are scrolled well above it by the time you have read them. */}
      {awaitingApproval ? (
        <div className="sticky bottom-4 z-10 mx-auto mt-6 flex max-w-[1080px] flex-wrap items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-strong)] bg-[var(--surface-3)] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.55)]">
          <span className="text-[13px] text-[var(--text-secondary)]">
            {selected.size === 0
              ? "Nothing selected — applying will dismiss all findings."
              : `${selected.size} of ${appliablePending} change${appliablePending === 1 ? "" : "s"} selected.`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setSelected(new Set());
                setBackfill(new Set());
              }}
              disabled={applying || selected.size === 0}
            >
              Clear
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onApply}
              disabled={applying}
            >
              {applying
                ? "Applying…"
                : selected.size === 0
                  ? "Dismiss all"
                  : `Apply ${selected.size} change${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

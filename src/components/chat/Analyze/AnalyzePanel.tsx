"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { CalendarClock, LayoutDashboard, Search } from "lucide-react";
import { pinChartsToBoardAction } from "@/app/boards/actions";
import { Spinner } from "@/components/ui";
import type { VerbKey, VerbMetadata } from "@/lib/discover/model";
import {
  useAnalyze,
  type AnalysisSource,
  type SectionKey,
} from "./AnalyzeProvider";
import { CardViz } from "./CardViz";
import { CompareSection } from "./CompareSection";
import { VERB_UI } from "./verbLabels";
import styles from "./Analyze.module.css";

/** One-line prompt shown under a section before (and until) it runs. */
const HINTS: Record<SectionKey, string> = {
  why: "Break this figure down by its biggest drivers.",
  disagree: "Find the slices that move against the trend.",
  shape: "Look for other metrics with this curve.",
  weird: "Surface the outliers and anomalies.",
  compare: "Fork this query into a side-by-side.",
};

/**
 * The five lazy sections, in reading order: the four verbs (labels + glyphs from
 * the relocated VERB_UI, so the same idea reads the same everywhere), then
 * Compare, whose glyph matches the chart's Compare tool.
 */
const SECTIONS: readonly { key: SectionKey; label: string; glyph: string; hint: string }[] = [
  ...VERB_UI.map((v) => ({
    key: v.key as SectionKey,
    label: v.label,
    glyph: v.glyph,
    hint: HINTS[v.key],
  })),
  { key: "compare", label: "Compare variants", glyph: "⑃", hint: HINTS.compare },
];

/** The four section keys that map 1:1 onto a verb (Compare is the exception). */
const VERB_KEYS: ReadonlySet<SectionKey> = new Set<SectionKey>([
  "why",
  "disagree",
  "shape",
  "weird",
]);

const isVerb = (key: SectionKey): key is VerbKey => VERB_KEYS.has(key);

const VERDICT_CLASS: Record<string, string | undefined> = {
  ok: styles.verdictOk,
  soft: styles.verdictSoft,
  bad: styles.verdictBad,
};

/**
 * The docked Analyze workspace: one per chat, opened from a chart's ⌕ tool.
 *
 * It renders inside a width-animating shell (see .panel) whose inner column is a
 * fixed 480px so the content never reflows while the panel slides in or out. A
 * top toolbar carries the workspace actions; below it every analysed chart is
 * stacked as its own collapsible card — each with the chart recap and the five
 * lazy accordion sections (the four verbs + Compare), all keyed by that chart's
 * analysis id so per-chart run/compare state is preserved as the stack grows.
 */
export function AnalyzePanel() {
  const { analyses, current, isOpen, close } = useAnalyze();
  const router = useRouter();

  // "Make dashboard" — pin every analysed chart that carries the material a
  // board tile needs (a query + a chart spec) onto a NEW board, then jump to it.
  // Charts without sql/encodings (e.g. a chart opened before the spec was wired,
  // or a stat) are silently left out; the count is surfaced on the button.
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const pinnable = analyses.filter(
    (a) =>
      a.sql &&
      a.chartType &&
      a.encodings &&
      Object.keys(a.encodings).length > 0,
  );
  const skipped = analyses.length - pinnable.length;

  const makeDashboard = () => {
    if (pinnable.length === 0 || pinBusy) return;
    const fallback = (pinnable[0]?.title || "Analysis").slice(0, 120);
    const named = window.prompt("Name the dashboard", fallback);
    if (named === null) return; // cancelled
    const title = named.trim().slice(0, 120) || fallback;

    setPinError(null);
    setPinBusy(true);
    void pinChartsToBoardAction({
      target: { kind: "new", title },
      charts: pinnable.map((a) => ({
        title: a.title || "Chart",
        sql: a.sql!,
        spec: {
          chartType: a.chartType!,
          encodings: a.encodings!,
          ...(a.horizontal ? { horizontal: true } : {}),
          ...(a.semanticTypes ? { semanticTypes: a.semanticTypes } : {}),
          ...(typeof a.span === "number" ? { span: a.span } : {}),
        },
      })),
    }).then((res) => {
      // On success we navigate away, so the busy state rides out the transition;
      // on failure it clears so the button is live again.
      if (res.ok) router.push(`/boards/${res.data.boardId}`);
      else {
        setPinError(res.error);
        setPinBusy(false);
      }
    });
  };

  // Per-card collapse, keyed by analysis id — cards start expanded. Focusing a
  // card (see below) forces it open, so opening an already-analysed chart always
  // reveals it even if the user had collapsed it.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleCard = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // A card ref per analysis id, so opening a chart can scroll its card into view.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setCardRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // When `current` changes (open() focuses a chart — new or already-analysed),
  // expand its card and scroll it into view rather than duplicating it.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!isOpen || !currentId) return;
    setCollapsed((prev) => {
      if (!prev.has(currentId)) return prev;
      const next = new Set(prev);
      next.delete(currentId);
      return next;
    });
    // Defer to next frame so a just-added card is mounted before we scroll.
    const raf = requestAnimationFrame(() => {
      cardRefs.current
        .get(currentId)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, currentId]);

  const hasCharts = analyses.length > 0;

  return (
    <aside
      className={`${styles.panel} ${isOpen ? styles.panelOpen : ""}`}
      aria-hidden={!isOpen}
      // While collapsed to zero width the panel is visually gone but its buttons
      // would still be tabbable — inert takes them out of the tab order and the
      // a11y tree until it opens.
      inert={!isOpen}
    >
      <div className={styles.inner}>
        <div className={styles.surface}>
        <header className={styles.toolbar}>
          <span className={styles.toolbarBrand}>
            <span className={styles.toolbarIcon}>
              <Search size={15} strokeWidth={2.25} aria-hidden="true" />
            </span>
            <span className={styles.toolbarTitle}>Analyze</span>
          </span>
          <div className={styles.toolbarActions}>
            <button
              type="button"
              className={styles.toolbarBtn}
              onClick={makeDashboard}
              disabled={pinnable.length === 0 || pinBusy}
              title={
                pinnable.length === 0
                  ? "Analyse a chart with a query first"
                  : skipped > 0
                    ? `Pin ${pinnable.length} chart${pinnable.length === 1 ? "" : "s"} to a new board (${skipped} without a query skipped)`
                    : `Pin ${pinnable.length} chart${pinnable.length === 1 ? "" : "s"} to a new board`
              }
            >
              <LayoutDashboard size={14} strokeWidth={2} aria-hidden="true" />
              <span>{pinBusy ? "Making…" : "Make dashboard"}</span>
            </button>
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.toolbarBtnIcon}`}
              disabled
              title="Time range — coming soon"
              aria-label="Time range (coming soon)"
            >
              <CalendarClock size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.close}
              onClick={close}
              aria-label="Close analysis panel"
            >
              ✕
            </button>
          </div>
        </header>

        {pinError ? (
          <p className={styles.toolbarError} role="alert">
            {pinError}
          </p>
        ) : null}

        {hasCharts ? (
          <div className={styles.stack}>
            {analyses.map((a) => (
              <ChartCard
                key={a.id}
                source={a}
                collapsed={collapsed.has(a.id)}
                onToggle={() => toggleCard(a.id)}
                registerRef={(el) => setCardRef(a.id, el)}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <p>Analyse a chart to start.</p>
          </div>
        )}
        </div>
      </div>
    </aside>
  );
}

/**
 * One chart in the stack: a collapsible card carrying the recap (title + type /
 * row-count chips) and the five lazy accordion sections. Everything below the
 * card header is keyed to this analysis id, so each card owns its own verb runs
 * and Compare session (via the provider's per-id state).
 */
function ChartCard({
  source,
  collapsed,
  onToggle,
  registerRef,
}: {
  source: AnalysisSource;
  collapsed: boolean;
  onToggle: () => void;
  registerRef: (el: HTMLElement | null) => void;
}) {
  const bodyId = `analyze-card-${source.id}`;
  return (
    <section className={styles.card} ref={registerRef}>
      <button
        type="button"
        className={styles.cardHead}
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
      >
        <span
          className={`${styles.cardChevron} ${collapsed ? "" : styles.cardChevronOpen}`}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className={styles.cardTitle}>
          {source.title || "Untitled chart"}
        </span>
      </button>

      <div id={bodyId} hidden={collapsed}>
        <div className={styles.recap}>
          <div className={styles.recapMeta}>
            {source.chartType ? (
              <span className={styles.recapChip}>{source.chartType}</span>
            ) : null}
            {source.data ? (
              <span className={styles.recapChip}>
                {source.data.length} row
                {source.data.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </div>

        <div className={styles.sections}>
          {SECTIONS.map((s) => (
            <Section key={s.key} analysisId={source.id} spec={s} />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * One accordion section. Expansion state lives per-analysis in the provider, so
 * scrolling away and coming back — or collapsing the whole card — restores
 * exactly what was open. Several can be open at once: the "everything together"
 * view.
 */
function Section({
  analysisId,
  spec,
}: {
  analysisId: string;
  spec: (typeof SECTIONS)[number];
}) {
  const { expandedFor, toggleSection, compareSessionFor } = useAnalyze();
  const open = expandedFor(analysisId).has(spec.key);
  const bodyId = `analyze-${analysisId}-${spec.key}`;
  // Compare stays mounted once its session exists, so collapsing the section
  // doesn't tear down the fork; it starts only on the first expand.
  const compareStarted =
    spec.key === "compare" && Boolean(compareSessionFor(analysisId));

  return (
    <section className={styles.section}>
      <button
        type="button"
        className={styles.sectionHead}
        onClick={() => toggleSection(analysisId, spec.key)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className={styles.sectionGlyph} aria-hidden="true">
          {spec.glyph}
        </span>
        <span className={styles.sectionLabel}>{spec.label}</span>
        <span
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      <div
        id={bodyId}
        className={`${styles.sectionBody} ${open ? styles.sectionBodyOpen : ""}`}
        role="region"
      >
        <div className={styles.sectionBodyInner}>
          {isVerb(spec.key) ? (
            <VerbSectionBody
              analysisId={analysisId}
              verb={spec.key}
              hint={spec.hint}
              open={open}
            />
          ) : open || compareStarted ? (
            // Compare forks on first expand and stays mounted thereafter so the
            // comparison survives collapsing the section.
            <CompareSection analysisId={analysisId} />
          ) : (
            <>
              <p className={styles.placeholder}>{spec.hint}</p>
              <p className={styles.placeholderRun}>Expand to run…</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * A verb section's live body. On first expand it asks the provider to start the
 * verb's durable run (idempotent + cached per chart), subscribes to that run, and
 * renders whatever its metadata reports — a computing state, then the streamed
 * VerbResult: reasoning text, a proof chart (CardViz), and an optional verdict.
 * The same anatomy the old explore WalkCard drew.
 */
function VerbSectionBody({
  analysisId,
  verb,
  hint,
  open,
}: {
  analysisId: string;
  verb: VerbKey;
  hint: string;
  open: boolean;
}) {
  const { ensureVerbRun, verbRunFor } = useAnalyze();

  // Start the run the first time the section is expanded; ensureVerbRun is
  // idempotent, so reopening or a re-render never re-triggers it.
  useEffect(() => {
    if (open) ensureVerbRun(analysisId, verb);
  }, [open, analysisId, verb, ensureVerbRun]);

  const runState = verbRunFor(analysisId, verb);
  const running = runState?.status === "running";

  const { run, error: runError } = useRealtimeRun(
    running ? runState.runId : undefined,
    {
      accessToken: running ? runState.accessToken : undefined,
      enabled: running,
    },
  );

  const meta = run?.metadata as VerbMetadata | undefined;
  const result = meta?.result ?? null;

  const failed =
    runState?.status === "error" ||
    meta?.status === "failed" ||
    run?.status === "FAILED" ||
    run?.status === "CRASHED" ||
    run?.status === "TIMED_OUT";

  // Idle — expanded hasn't happened yet (or is mid-tick). Show the section's hint.
  if (!runState) {
    return (
      <>
        <p className={styles.placeholder}>{hint}</p>
        <p className={styles.placeholderRun}>Expand to run…</p>
      </>
    );
  }

  if (failed) {
    const message =
      runState.status === "error"
        ? runState.error
        : (meta?.error ??
          (runError instanceof Error ? runError.message : "That verb failed."));
    return (
      <p className={styles.verbError} role="alert">
        {message}
      </p>
    );
  }

  if (!result) {
    return (
      <div className={styles.verbLoading}>
        <Spinner label="" />
        <span className={styles.verbLoadingNote}>
          {typeof meta?.probeCount === "number" && meta.probeCount > 0
            ? `looking at the data (${meta.probeCount})…`
            : "computing…"}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.verbResult} aria-label={result.signal}>
      <div className={styles.verbHead}>
        <span className={styles.verbSignal}>{result.signal}</span>
        {result.verdict ? (
          <span
            className={`${styles.verbVerdict} ${VERDICT_CLASS[result.verdict.tone] ?? ""}`}
            title={result.verdict.note ?? undefined}
          >
            {result.verdict.label}
          </span>
        ) : null}
      </div>

      <div className={styles.verbViz}>
        <CardViz
          rows={result.rows}
          error={result.error}
          chartType={result.chartType}
          encodings={result.encodings}
          title={result.signal}
        />
      </div>

      <p className={styles.verbFinding}>{result.finding}</p>
      {result.verdict?.note ? (
        <p className={styles.verbVerdictNote}>{result.verdict.note}</p>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { Spinner } from "@/components/ui";
import type { VerbKey, VerbMetadata } from "@/lib/discover/model";
import { useAnalyze, type SectionKey } from "./AnalyzeProvider";
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
 * The docked Analyze panel: one per chat, opened from a chart's ⌕ tool.
 *
 * It renders inside a width-animating shell (see .panel) whose inner column is a
 * fixed 480px so the content never reflows while the panel slides in or out. The
 * four verb sections run their durable `run-verb` task on first expand and stream
 * the result; the fifth, Compare, forks the chart's query on first expand and
 * renders the branch tiles inline (CompareSection).
 */
/** Custom (non-native) dropdown to switch between analysed charts. */
function AnalysisSwitcher({
  analyses,
  current,
  onSwitch,
}: {
  analyses: { id: string; title: string }[];
  current: { id: string; title: string } | null;
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const empty = analyses.length === 0;
  const label = current?.title || (empty ? "No charts analysed yet" : "Untitled chart");

  return (
    <div className={styles.switcher} ref={ref}>
      <span className={styles.eyebrow}>Analysis</span>
      <button
        type="button"
        className={styles.switchBtn}
        disabled={empty}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.switchLabel}>{label}</span>
        <span className={`${styles.caret} ${open ? styles.caretOpen : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && !empty ? (
        <ul className={styles.menu} role="listbox">
          {analyses.map((a) => (
            <li key={a.id} role="option" aria-selected={a.id === current?.id}>
              <button
                type="button"
                className={`${styles.menuItem} ${a.id === current?.id ? styles.menuItemActive : ""}`}
                onClick={() => {
                  onSwitch(a.id);
                  setOpen(false);
                }}
              >
                {a.title || "Untitled chart"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AnalyzePanel() {
  const { analyses, current, isOpen, close, switchTo } = useAnalyze();

  return (
    <aside
      className={`${styles.panel} ${isOpen ? styles.panelOpen : ""}`}
      aria-hidden={!isOpen}
      // While collapsed to zero width the panel is visually gone but its select
      // and buttons would still be tabbable — inert takes them out of the tab
      // order and the a11y tree until it opens.
      inert={!isOpen}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true">
            ⌕
          </span>
          <AnalysisSwitcher
            analyses={analyses}
            current={current}
            onSwitch={switchTo}
          />
          <button
            type="button"
            className={styles.close}
            onClick={close}
            aria-label="Close analysis panel"
          >
            ✕
          </button>
        </header>

        {current ? (
          <div className={styles.body}>
            <section className={styles.recap}>
              <span className={styles.recapEyebrow}>Analysing chart</span>
              <p className={styles.recapTitle}>
                {current.title || "Untitled chart"}
              </p>
              <div className={styles.recapMeta}>
                {current.chartType ? (
                  <span className={styles.recapChip}>{current.chartType}</span>
                ) : null}
                {current.data ? (
                  <span className={styles.recapChip}>
                    {current.data.length} row
                    {current.data.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            </section>

            <div className={styles.sections}>
              {SECTIONS.map((s) => (
                <Section key={s.key} analysisId={current.id} spec={s} />
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.empty}>
            <p>Open a chart&rsquo;s ⌕ tool to analyse it here.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * One accordion section. Expansion state lives per-analysis in the provider, so
 * scrolling away and coming back — or switching charts — restores exactly what
 * was open. Several can be open at once: that's the "everything together" view.
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, LayoutDashboard } from "lucide-react";
import { pinChartsToBoardAction } from "@/app/boards/actions";
import type { ResultRow } from "@/lib/discover/model";
import { useAnalyze, type AnalysisSource } from "./AnalyzeProvider";
import { CardViz } from "./CardViz";
import styles from "./Analyze.module.css";

/**
 * The docked Analyze workspace: one per chat, opened from a chart's ⌕ tool.
 *
 * It renders inside a width-animating shell (see .panel) whose inner column is a
 * fixed width so the content never reflows while the panel slides in or out. A
 * top toolbar carries the workspace actions; below it every analysed chart is
 * tiled into a 2-column grid as its own card (chart + a short recap), keyed by
 * that chart's analysis id.
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

  // A card ref per analysis id, so opening a chart can scroll its card into view.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const setCardRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  // When `current` changes (open() focuses a chart — new or already-analysed),
  // scroll it into view rather than duplicating it.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!isOpen || !currentId) return;
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
 * One chart in the grid: a static title header over the chart.
 */
function ChartCard({
  source,
  registerRef,
}: {
  source: AnalysisSource;
  registerRef: (el: HTMLElement | null) => void;
}) {
  return (
    <section className={styles.card} ref={registerRef}>
      <header className={styles.cardHead}>
        <span className={styles.cardTitle}>
          {source.title || "Untitled chart"}
        </span>
      </header>

      {source.data && source.data.length > 0 ? (
        <div className={styles.cardChart}>
          <CardViz
            rows={source.data as ResultRow[]}
            error={null}
            {...(source.chartType ? { chartType: source.chartType } : {})}
            {...(source.encodings ? { encodings: source.encodings } : {})}
            title={source.title}
          />
        </div>
      ) : null}
    </section>
  );
}

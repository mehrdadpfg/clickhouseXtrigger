"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { lineDiff } from "@/lib/textDiff";
import {
  applyBoardOptimizeAction,
  loadBoardOptimizeAction,
  startBoardOptimizeAction,
  type OptimizeView,
} from "@/app/boards/optimize";
import styles from "./OptimizePanel.module.css";

/**
 * The board Optimize panel.
 *
 * Opens into a waiting state the moment the reader presses Optimize: it triggers
 * the `optimize-board` Trigger task, then polls the run (server-side, so no
 * Trigger credential reaches the browser — the same choice Tune makes) until the
 * task has proposed its rewrites. Each changed tile is shown as a git-style diff
 * of its query — only the lines that change — with a checkbox. Applying completes
 * the run's one waitpoint token with the ticked tiles; the task repoints them and
 * the board reloads.
 */
export function OptimizePanel({
  boardId,
  onClose,
  onApplied,
}: {
  boardId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [view, setView] = useState<OptimizeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const runIdRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);
  const seededRef = useRef(false);
  // Set once Apply is pressed. After that the run goes awaiting_approval →
  // applying → done, and the FIRST poll after completing the token often still
  // reads awaiting_approval (the task hasn't resumed yet). Without this we'd stop
  // polling on that stale status and never see `done`, leaving the panel stuck on
  // "Applying…" even though the run finished — so once applied, keep polling
  // through anything that isn't a terminal status.
  const appliedRef = useRef(false);

  const poll = useCallback(async (runId: string) => {
    const next = await loadBoardOptimizeAction(runId);
    if ("error" in next) {
      setError(next.error);
      return;
    }
    setView(next);
    // Tick every changed tile by default, once, the first time they arrive.
    if (!seededRef.current && next.proposals.some((p) => p.changed)) {
      seededRef.current = true;
      setSelected(
        new Set(next.proposals.filter((p) => p.changed).map((p) => p.tileId)),
      );
    }
    const terminal = next.status === "done" || next.status === "unavailable";
    if (
      next.status === "starting" ||
      next.status === "analyzing" ||
      next.status === "applying" ||
      // After Apply, keep polling through the brief awaiting_approval → applying
      // window until the run actually reaches a terminal status.
      (appliedRef.current && !terminal)
    ) {
      timerRef.current = setTimeout(() => void poll(runId), 1200);
    }
  }, []);

  // Kick the run off on mount, exactly once (StrictMode double-invokes effects).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const res = await startBoardOptimizeAction(boardId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      runIdRef.current = res.runId;
      void poll(res.runId);
    })();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [boardId, poll]);

  // Once an apply run reaches done, the tiles are repointed — reload the board.
  useEffect(() => {
    if (applying && view?.status === "done") onApplied();
  }, [applying, view?.status, onApplied]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async () => {
    const runId = runIdRef.current;
    if (!runId || selected.size === 0) return;
    setApplying(true);
    setError(null);
    const res = await applyBoardOptimizeAction(runId, [...selected]);
    if (!res.ok) {
      setError(res.error ?? "Could not apply.");
      setApplying(false);
      return;
    }
    appliedRef.current = true; // keep polling until the run reaches `done`
    if (timerRef.current) clearTimeout(timerRef.current);
    void poll(runId); // watch applying → done
  };

  const changed = view?.proposals.filter((p) => p.changed) ?? [];
  const unchanged = (view?.proposals.length ?? 0) - changed.length;
  const busy =
    !view || view.status === "starting" || view.status === "analyzing";
  const decided = view?.status === "applying" || view?.status === "done";

  return (
    <div className={styles.panel}>
      <header className={styles.head}>
        <h2 className={styles.title}>Optimize</h2>
        <p className={styles.sub}>
          Repoint tile queries at materialized views for faster loads.
        </p>
      </header>

      <div className={styles.body}>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : busy ? (
          <div className={styles.waiting}>
            <span className={styles.spinner} aria-hidden="true" />
            <span>Analyzing tiles against materialized views…</span>
          </div>
        ) : changed.length === 0 ? (
          <div className={styles.empty}>
            <p>{view?.summary || "Nothing to optimize on this board."}</p>
            {view && view.mvCount > 0 ? (
              <p className={styles.emptyHint}>
                {view.mvCount} materialized view
                {view.mvCount === 1 ? "" : "s"} checked — none served these
                tiles better than the base table.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {view?.summary ? (
              <p className={styles.summary}>{view.summary}</p>
            ) : null}
            <ul className={styles.list}>
              {changed.map((p) => {
                const lines = lineDiff(p.oldSql, p.newSql).filter(
                  (l) => l.type !== "context",
                );
                return (
                  <li key={p.tileId} className={styles.item}>
                    <label className={styles.itemHead}>
                      {!decided ? (
                        <input
                          type="checkbox"
                          className={styles.check}
                          checked={selected.has(p.tileId)}
                          onChange={() => toggle(p.tileId)}
                        />
                      ) : (
                        <span
                          className={`${styles.badge} ${
                            styles[`badge_${p.status}`] ?? ""
                          }`}
                        >
                          {p.status}
                        </span>
                      )}
                      <span className={styles.itemTitle}>{p.title}</span>
                      {p.mvUsed ? (
                        <span className={styles.mv}>{p.mvUsed}</span>
                      ) : null}
                    </label>
                    {p.note ? <p className={styles.note}>{p.note}</p> : null}
                    <pre className={styles.diff}>
                      {lines.map((l, i) => (
                        <div
                          key={i}
                          className={l.type === "add" ? styles.add : styles.del}
                        >
                          <span className={styles.sign}>
                            {l.type === "add" ? "+" : "−"}
                          </span>
                          {l.text}
                        </div>
                      ))}
                    </pre>
                    {p.error ? (
                      <p className={styles.error}>{p.error}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {unchanged > 0 ? (
              <p className={styles.footnote}>
                {unchanged} tile{unchanged === 1 ? "" : "s"} left unchanged.
              </p>
            ) : null}
          </>
        )}
      </div>

      <footer className={styles.foot}>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {decided ? "Close" : "Cancel"}
        </Button>
        {!busy && !decided && changed.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            disabled={selected.size === 0 || applying}
            onClick={apply}
          >
            {applying ? "Applying…" : `Apply ${selected.size}`}
          </Button>
        ) : null}
      </footer>
    </div>
  );
}

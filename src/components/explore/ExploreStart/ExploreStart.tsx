"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import {
  byRowsDesc,
  ctaLabel,
  matchesQuery,
  type TableChoice,
} from "../model";
import styles from "./ExploreStart.module.css";

/**
 * Explore — start an exploration by curating the scope.
 *
 * The warehouse's tables are listed live (server-read, handed in as props); the
 * human multi-selects the ones worth bringing together and, optionally, says
 * what they're after. Submitting carries that scope to the discovery step,
 * which is where the agent works out how the chosen tables connect. Nothing
 * here assumes a dataset — every table, count and label came from introspection.
 */
export function ExploreStart({
  tables,
  error,
}: {
  tables: TableChoice[];
  error?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => [...tables].sort(byRowsDesc), [tables]);
  const visible = useMemo(
    () => sorted.filter((t) => matchesQuery(t, query)),
    [sorted, query],
  );

  // The scope reads in the order the tables were picked, so the chips below the
  // list mirror the analyst's own sequence rather than the row order.
  const picked = useMemo(
    () => sorted.filter((t) => selected.has(t.id)),
    [sorted, selected],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = () => {
    if (selected.size === 0) return;
    const params = new URLSearchParams();
    params.set("tables", picked.map((t) => t.id).join(","));
    const trimmed = focus.trim();
    if (trimmed) params.set("focus", trimmed);
    router.push(`/explore/discover?${params.toString()}`);
  };

  if (error) {
    return (
      <main className={styles.page}>
        <div className={styles.wrap}>
          <header className={styles.head}>
            <span className={styles.eyebrow}>Vantage · recognition, not recall</span>
            <h1 className={styles.title}>
              Explore <span className={styles.dot}>◈</span>
            </h1>
          </header>
          <div className={styles.disconnected}>
            <p>Couldn&rsquo;t reach ClickHouse to list the tables.</p>
            <code>{error}</code>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.head}>
          <span className={styles.eyebrow}>Vantage · recognition, not recall</span>
          <h1 className={styles.title}>
            Explore <span className={styles.dot}>◈</span>
          </h1>
          <p className={styles.lede}>
            A warehouse is a pile of tables that mostly don&rsquo;t relate. Pick
            the ones worth <b>bringing together</b> — Vantage finds how they
            connect and nominates what&rsquo;s worth noticing, then every finding
            carries the same four questions.
          </p>
          <div className={styles.meta}>
            <span>
              <b>{tables.length}</b> table{tables.length === 1 ? "" : "s"} in scope
            </span>
            <span className={styles.sep}>·</span>
            <span>select one to explore, or several to correlate</span>
          </div>
        </header>

        <div className={styles.search}>
          <span className={styles.searchIcon} aria-hidden="true">
            ⌕
          </span>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tables…"
            aria-label="Search tables"
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              className={styles.clear}
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className={styles.list}>
          {visible.length === 0 ? (
            <p className={styles.empty}>No tables match &ldquo;{query}&rdquo;.</p>
          ) : (
            visible.map((t) => {
              const on = selected.has(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`${styles.row} ${on ? styles.rowOn : ""}`}
                  onClick={() => toggle(t.id)}
                  aria-pressed={on}
                >
                  <span className={styles.check} aria-hidden="true">
                    ✓
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTop}>
                      <span className={styles.tableName}>{t.name}</span>
                      <span className={styles.db}>{t.database}</span>
                    </span>
                    {t.comment ? (
                      <span className={styles.comment}>{t.comment}</span>
                    ) : null}
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.rowMetaMain}>{t.rowsLabel}</span>
                    <span className={styles.rowMetaSub}>
                      {t.engine}
                      {t.sizeLabel ? ` · ${t.sizeLabel}` : ""}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className={styles.dock}>
        <div className={styles.dockInner}>
          {picked.length > 0 ? (
            <div className={styles.scopeRow}>
              <span className={styles.scopeLabel}>scope</span>
              {picked.map((t) => (
                <span key={t.id} className={styles.scopeChip}>
                  {t.name}
                  <button
                    type="button"
                    onClick={() => toggle(t.id)}
                    aria-label={`Remove ${t.name} from scope`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className={styles.controls}>
            <input
              className={styles.focus}
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Anything specific you're after? (optional)"
              aria-label="Optional focus"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") start();
              }}
            />
            <Button
              variant="primary"
              className={styles.go}
              onClick={start}
              disabled={selected.size === 0}
            >
              {ctaLabel(selected.size)}
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

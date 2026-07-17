/**
 * The Tune page's view model — pure shapes and formatting, no I/O.
 *
 * This is the contract between the route (which reads Trigger run metadata and
 * the query log) and the components (which only render). It carries no token
 * ids or credentials: a suggestion is addressed by its opaque `id`, and the
 * route resolves that to a waitpoint token server-side.
 */

export type SuggestionKind = "materialized_view" | "projection";
export type SuggestionStatus = "pending" | "applied" | "failed" | "dismissed";

/** One optimization the agent proposed, flattened for rendering. */
export type SuggestionView = {
  id: string;
  kind: SuggestionKind;
  name: string;
  targetTable: string;
  title: string;
  rationale: string;
  questionsCovered: number;
  estStorage: string;
  estSpeedup: string;
  /** The DDL, statements joined for display. */
  sql: string;
  status: SuggestionStatus;
  error?: string;
  decidedAt?: string;
};

/** One row of "from your history" — a real query-log pattern. */
export type EvidenceView = {
  queryHash: string;
  /** A short human label distilled from the query. */
  label: string;
  /** The representative query, for the tooltip / detail. */
  sql: string;
  count: number;
  avgDurationMs: number;
  totalReadRows: number;
  tables: string[];
  /** True once an applied suggestion covers this pattern's hash. */
  materialized: boolean;
};

/**
 * The run's lifecycle as the page cares about it. `idle` means no analysis has
 * run yet; `failed` means the run errored before finishing.
 */
export type TuneRunStatus =
  | "idle"
  | "analyzing"
  | "proposing"
  | "awaiting_approval"
  | "done"
  | "failed";

export type TuneView = {
  /** The run backing this view, or null when none has ever run. */
  runId: string | null;
  runStatus: TuneRunStatus;
  finding: string | null;
  windowDays: number;
  totalQueries: number;
  distinctPatterns: number;
  suggestions: SuggestionView[];
  evidence: EvidenceView[];
};

/** Actions the page hands the component. Passed as props to keep deps app → components → lib. */
export type TuneActions = {
  /** Kick off a fresh analysis. Returns the new run's id. */
  start: () => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  /** Re-read a run's state. Omit the id to read the latest run. */
  refresh: (runId?: string) => Promise<TuneView>;
  /** Approve (true) or dismiss (false) one suggestion. */
  decide: (
    runId: string,
    suggestionId: string,
    approved: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
};

// --- formatting ------------------------------------------------------------

export function kindLabel(kind: SuggestionKind): string {
  return kind === "materialized_view" ? "MATERIALIZED VIEW" : "PROJECTION";
}

/** "×14", "×1" — how a pattern's recurrence reads in the evidence list. */
export function formatCount(n: number): string {
  return `×${n.toLocaleString("en-US")}`;
}

/** "90ms", "1.4s" — durations at the two scales the evidence spans. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** "20.0M rows", "3.1K rows" — compact row counts. */
export function formatRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M rows`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K rows`;
  return `${n} rows`;
}

/**
 * A short, human label for a query pattern: its output columns if it is a
 * recognisable `SELECT … FROM`, else a trimmed head of the SQL. Best-effort and
 * purely cosmetic — the hash is the pattern's identity, not this string.
 */
export function labelForQuery(sql: string): string {
  const match = /^\s*select\s+(.+?)\s+from\s/is.exec(sql);
  const projection = (match?.[1] ?? sql).replace(/\s+/g, " ").trim();
  // Drop `as alias` noise so "count() as trips, avg(tip) as avg_tip" reads short.
  const cleaned = projection.replace(/\s+as\s+[\w`]+/gi, "");
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned;
}

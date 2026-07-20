/**
 * The Tune page's view model — pure shapes and formatting, no I/O.
 *
 * The contract between the route (which reads Trigger run metadata) and the
 * components (which only render). It carries no token ids or credentials: a
 * finding is addressed by its opaque `id`, and the route resolves that to a
 * waitpoint token server-side.
 */

export type Impact = "CRITICAL" | "HIGH" | "MEDIUM";

export type OptimizationKind =
  | "materialized_view"
  | "projection"
  | "skip_index"
  | "column_type"
  | "column_codec"
  | "ttl"
  | "order_by"
  | "partitioning"
  | "engine"
  | "denormalize"
  | "ingestion"
  | "query_rewrite";

/**
 * `advisory` is terminal and arrives that way — it is not a decision the reader
 * declined, it is a finding ClickHouse cannot apply in place at all.
 */
export type FindingStatus =
  | "pending"
  | "applied"
  | "failed"
  | "dismissed"
  | "advisory";

export type FindingView = {
  id: string;
  kind: OptimizationKind;
  impact: Impact;
  /** The best-practice rule cited, e.g. `schema-types-lowcardinality`. */
  ruleId: string;
  targetTable: string;
  title: string;
  rationale: string;
  /** The measurement behind it — a distinct count, a ratio, a part count. */
  evidence: string;
  estimate: string;
  /** DDL for display. Empty on advisory findings. */
  sql: string;
  /** What the reader would have to do instead. Advisory findings only. */
  migration: string;
  caveat: string;
  status: FindingStatus;
  error?: string;
  decidedAt?: string;
};

/** One row of "from your history" — a real query-log pattern. */
export type EvidenceView = {
  queryHash: string;
  label: string;
  sql: string;
  count: number;
  avgDurationMs: number;
  totalReadRows: number;
  tables: string[];
};

export type TuneRunStatus =
  | "idle"
  | "analyzing"
  | "investigating"
  | "proposing"
  | "awaiting_approval"
  | "done"
  | "failed";

export type TuneView = {
  runId: string | null;
  runStatus: TuneRunStatus;
  finding: string | null;
  windowDays: number;
  totalQueries: number;
  distinctPatterns: number;
  /**
   * How much history system.query_log actually held. Shown instead of
   * `windowDays` when it is shorter, because ClickHouse Cloud rotates the log
   * within the hour and "14 days" would otherwise be a claim the data cannot
   * support.
   */
  retainedMinutes: number;
  tablesProfiled: number;
  columnsProfiled: number;
  findings: FindingView[];
  evidence: EvidenceView[];
};

export type TuneActions = {
  start: () => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  refresh: (runId?: string) => Promise<TuneView>;
  /**
   * Apply the ticked findings. One call for the whole report — the run parks on
   * a single waitpoint, so decisions are submitted together rather than one at
   * a time. Anything not listed is dismissed.
   */
  apply: (
    runId: string,
    findingIds: string[],
  ) => Promise<{ ok: boolean; error?: string; applying?: number }>;
};

// --- presentation ----------------------------------------------------------

export const IMPACT_ORDER: Record<Impact, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
};

const KIND_LABEL: Record<OptimizationKind, string> = {
  materialized_view: "Materialized view",
  projection: "Projection",
  skip_index: "Skip index",
  column_type: "Column type",
  column_codec: "Codec",
  ttl: "TTL",
  order_by: "Sort key",
  partitioning: "Partitioning",
  engine: "Engine",
  denormalize: "Join strategy",
  ingestion: "Ingestion",
  query_rewrite: "Query shape",
};

export function kindLabel(kind: OptimizationKind): string {
  return KIND_LABEL[kind] ?? kind;
}

/** Only a pending finding has buttons; everything else is already resolved. */
export function isDecidable(status: FindingStatus): boolean {
  return status === "pending";
}

/**
 * Findings grouped by impact, each group's members sorted by table so one
 * table's problems read together. Empty groups are dropped rather than rendered
 * — an empty CRITICAL heading reads as a warning in itself.
 */
export function groupByImpact(
  findings: FindingView[],
): { impact: Impact; findings: FindingView[] }[] {
  const order: Impact[] = ["CRITICAL", "HIGH", "MEDIUM"];
  return order
    .map((impact) => ({
      impact,
      findings: findings
        .filter((f) => f.impact === impact)
        .sort((a, b) => a.targetTable.localeCompare(b.targetTable)),
    }))
    .filter((group) => group.findings.length > 0);
}

/** "×14" — how a pattern's recurrence reads in the evidence list. */
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
  const cleaned = projection.replace(/\s+as\s+[\w`]+/gi, "");
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned;
}

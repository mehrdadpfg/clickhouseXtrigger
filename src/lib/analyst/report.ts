/**
 * The analyst deep-dive data model — the STABLE INTERFACE the whole feature
 * hangs off.
 *
 * The orchestrator (triage → specialist fan-out → synthesis) exists to produce
 * one thing: an `AnalystReport`. Everything upstream is how it is built and
 * everything downstream is how it is shown, but the report itself is the
 * contract between the two, so the surface can change later (a report page,
 * board tiles) without touching the orchestration. For this iteration it is
 * rendered inline in the chat thread.
 *
 * Two kinds of shape live here:
 *
 *   - Zod schemas for the parts a model AUTHORS — the triage classification, a
 *     specialist's proposed charts/stats/recommendations, the synthesis
 *     selection. These are validated at the generateObject boundary, exactly
 *     like discover/model.ts and tune.ts.
 *   - Plain types for the ASSEMBLED report, whose charts already carry the rows
 *     their SQL returned. A model never writes those rows — the numbers come
 *     from running the model's SQL read-only, so a chart can't be hallucinated.
 *
 * Nothing here knows a table or column name: the shapes are identical for a
 * product catalog and a logs table. Server-safe and free of any client or db
 * import, so the UI can import the TYPES (type-only) without pulling it in —
 * the same discipline as discover/model.ts.
 */
import { z } from "zod";
import { LENS_IDS, type LensId } from "./lenses";

// --- what a specialist proposes -------------------------------------------

/**
 * A chart a specialist wants on the board, as a spec + the SQL that fills it.
 *
 * No `data` field: the specialist runs this SQL read-only and the rows are
 * attached deterministically (see `ReportChart`). The spec mirrors the chat's
 * `renderChart` tool and the `ChartSpec` the EChart pipeline compiles, so the
 * report reuses that exact renderer rather than inventing one.
 */
export const ChartCandidate = z.object({
  /** Slug unique within this lens, e.g. "revenue-by-month". */
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  /** A flint chart type, e.g. "Line Chart", "Bar Chart", "Pie Chart". */
  chartType: z.string().min(1).max(40),
  /** channel → column alias in the SELECT, e.g. {"x":"month","y":"revenue"}. */
  encodings: z.record(z.string(), z.string()),
  /** One read-only aggregated SELECT. Qualified db.table, no trailing semicolon. */
  sql: z.string().min(1).max(4_000),
  /** Bar-family only: lay bars horizontally so long labels stay level. */
  horizontal: z.boolean().optional(),
  /** Optional field → semantic hint (Quantity, Time, Percentage, …). */
  semanticTypes: z.record(z.string(), z.string()).optional(),
  /** One line on what the chart shows — feeds the synthesis catalog. */
  caption: z.string().max(240).default(""),
});
export type ChartCandidate = z.infer<typeof ChartCandidate>;

/**
 * A headline KPI a specialist wants shown. `sql` returns ONE number (one row,
 * one column); the value is read from running it, never authored by the model.
 */
export const StatCandidate = z.object({
  id: z.string().min(1).max(64),
  /** The metric's name, e.g. "Total revenue", "Null rate on email". */
  label: z.string().min(1).max(80),
  /** A single read-only SELECT returning ONE number. */
  sql: z.string().min(1).max(4_000),
  unit: z.enum(["", "$", "%", "×"]).optional(),
});
export type StatCandidate = z.infer<typeof StatCandidate>;

/** Actionable recommendation kinds — the "so what does the reader DO" ladder. */
export const RECOMMENDATION_CATEGORIES = [
  "materialized_view",
  "rollup",
  "projection_index",
  "schema_type",
  "partitioning",
  "join_enrichment",
  "new_metric",
  "external",
] as const;
export type RecommendationCategory = (typeof RECOMMENDATION_CATEGORIES)[number];

/**
 * One ranked, actionable recommendation.
 *
 * `proposedSql` is SHOWN, never run — recommendations are proposals ("create
 * this materialized view", "roll this raw table up", "join table Y"), and the
 * DDL/SQL is there for the reader to copy and run themselves. `exploratory`
 * flags anything resting on external or speculative evidence (competitor
 * context) so it can't be mistaken for a hard-data finding.
 */
export const Recommendation = z.object({
  id: z.string().min(1).max(64),
  category: z.enum(RECOMMENDATION_CATEGORIES),
  impact: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  title: z.string().min(1).max(140),
  /** Why it matters here, one or two lines. Plain language, may reference numbers. */
  rationale: z.string().min(1).max(800),
  /** The measurement that establishes it — a count, a ratio. What makes it not a guess. */
  evidence: z.string().max(500).default(""),
  /** Proposed SQL/DDL, one statement per element. Shown, never executed. May be empty. */
  proposedSql: z.array(z.string()).default([]),
  /** True for external/speculative findings (competitor analysis, market context). */
  exploratory: z.boolean().default(false),
});
export type Recommendation = z.infer<typeof Recommendation>;

/** What a specialist's report step returns, before its SQL is run. */
export const SpecialistReport = z.object({
  /** One-sentence headline for this lens, no SQL. */
  takeaway: z.string().min(1).max(280),
  charts: z.array(ChartCandidate).max(6).default([]),
  stats: z.array(StatCandidate).max(6).default([]),
  recommendations: z.array(Recommendation).max(6).default([]),
});
export type SpecialistReport = z.infer<typeof SpecialistReport>;

// --- triage ----------------------------------------------------------------

/** What the triage step decides: the domain and which lenses to dispatch. */
export const TriageResult = z.object({
  /** The dataset's domain in a few words, e.g. "E-commerce product catalog". */
  domain: z.string().min(1).max(120),
  /** One line on how the shape of the data implies that domain. */
  domainRationale: z.string().min(1).max(500),
  /** The lenses worth running for THIS data. At least one. */
  lenses: z.array(z.enum(LENS_IDS)).min(1),
  /** Guidance handed to every specialist — what to prioritise for this dataset. */
  focusNotes: z.string().max(600).default(""),
});
export type TriageResult = z.infer<typeof TriageResult>;

// --- synthesis -------------------------------------------------------------

/**
 * What synthesis returns: it CURATES rather than authors. It selects and orders
 * the charts, stats and recommendations the specialists produced (by id) and
 * writes the overview — but never rewrites a specialist's SQL, DDL or evidence,
 * so the numbers and proposals stay exactly as they were measured.
 */
export const SynthesisResult = z.object({
  /** 2–4 short paragraphs of markdown tying the findings together. No SQL. */
  overview: z.string().min(1).max(4_000),
  /** Chart ids to show, best first. Namespaced `${lens}.${id}`. Deduped. */
  chartIds: z.array(z.string()).max(10).default([]),
  /** Stat ids to show as the KPI strip, most important first. */
  statIds: z.array(z.string()).max(8).default([]),
  /** Recommendation ids, ranked most actionable/impactful first. Deduped. */
  recommendationIds: z.array(z.string()).max(12).default([]),
});
export type SynthesisResult = z.infer<typeof SynthesisResult>;

// --- the assembled report (charts carry their rows) ------------------------

/** A JSON value — what survives the tool-result / metadata channel. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A row of a chart's result. Column names are the analyst's, never ours. */
export type ReportRow = Record<string, JsonValue>;

/** A chart after its SQL has been run — self-contained, renders from embedded rows. */
export type ReportChart = Omit<ChartCandidate, "id"> & {
  /** Namespaced id, `${lens}.${id}`. */
  id: string;
  lens: LensId;
  data: ReportRow[];
};

/** A KPI after its SQL has been run — the number is measured, not authored. */
export type ReportStat = {
  id: string;
  lens: LensId;
  label: string;
  value: number;
  unit?: "" | "$" | "%" | "×";
};

/** A recommendation carried into the report with the lens that surfaced it. */
export type ReportRecommendation = Recommendation & { lens: LensId };

/** One line about a lens that ran, for the report header. */
export type LensRun = { id: LensId; label: string; takeaway: string };

/**
 * The deep-dive report. THE stable interface: whatever surfaces it (chat today)
 * reads only this. `version` is stamped so a persisted or in-flight report can
 * be told apart from a future shape without guessing.
 */
export type AnalystReport = {
  version: 1;
  /** The db.table ids the deep-dive covered. */
  tables: string[];
  /** The classified domain, from triage. */
  domain: string;
  /** The lenses that ran and their one-line takeaways. */
  lenses: LensRun[];
  /** Markdown synthesis tying the findings together. */
  overview: string;
  /** Headline KPIs, ranked. */
  stats: ReportStat[];
  /** Deduped charts, ranked. */
  charts: ReportChart[];
  /** Ranked, actionable recommendations. */
  recommendations: ReportRecommendation[];
};

/** Status a deep-dive run publishes to its metadata as it works. */
export type AnalystStatus =
  | "triaging"
  | "investigating"
  | "synthesizing"
  | "done"
  | "failed";

/** The whole of a deep-dive run's metadata — what a caller can subscribe to. */
export type AnalystMetadata = {
  status: AnalystStatus;
  tables: string[];
  domain: string | null;
  /** The lenses triage chose to dispatch, once it has. */
  lenses: LensId[];
  /** Filled once the run completes; null while working. */
  report: AnalystReport | null;
  /** Present only when status is "failed". */
  error: string | null;
};

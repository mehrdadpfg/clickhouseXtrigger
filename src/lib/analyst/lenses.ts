/**
 * The analytical LENSES a deep-dive can dispatch.
 *
 * Each lens owns exactly ONE way of looking at a dataset, and a specialist
 * agent is spun up per lens (fanned out from the orchestrator). This is data,
 * not prose in a prompt, for the same reason the tune rulebook is: two
 * consumers must agree on the set — triage, which PICKS the lenses from the
 * shape of the data, and the specialist task, which is briefed by the one it
 * was handed. Deriving both from this table means a lens can't be pickable but
 * unbriefed, or briefed but unpickable.
 *
 * Which lenses fire is decided by the data, not fixed: a product table earns
 * the `external` competitor lens, a logs table does not. Triage reads the
 * `whenToUse` lines below to make that call.
 *
 * Server-safe and free of any client/db import: the report model imports the
 * ids and the UI imports the labels (type-only), same discipline as
 * discover/model.ts.
 */

export const LENS_IDS = [
  "structure",
  "quality",
  "trends",
  "segments",
  "enrichment",
  "external",
] as const;

export type LensId = (typeof LENS_IDS)[number];

export type Lens = {
  id: LensId;
  /** How the report and the work card name it. */
  label: string;
  /** The one thing this lens looks at, for triage's benefit. */
  whenToUse: string;
  /**
   * The lens-specific brief handed to the specialist — appended to the shared
   * specialist instructions. Says what to investigate and what to propose.
   */
  brief: string;
  /**
   * External/speculative: rests on evidence outside the dataset (the web), so
   * every finding it produces is flagged `exploratory` in the report.
   */
  exploratory?: boolean;
};

export const LENSES: Lens[] = [
  {
    id: "structure",
    label: "Structure & storage",
    whenToUse:
      "Always worth running. The physical schema — ORDER BY, column types, " +
      "codecs, partitioning, materialized views and projections — versus how " +
      "the data is actually stored and queried.",
    brief: [
      "LENS: Physical structure & storage.",
      "Look at how the data is stored versus how it is shaped. Consider:",
      "- Columns typed String that hold numbers, dates, IPs, UUIDs, or a small",
      "  closed set of values (LowCardinality / Enum candidates). A high",
      "  compression ratio is a hint; confirm distinct counts before proposing.",
      "- Whether the ORDER BY / sorting key leads with the columns the data would",
      "  actually be filtered on.",
      "- A recurring heavy aggregation that a materialized view or a projection",
      "  would serve from thousands of rows instead of billions.",
      "- A large raw table with an obvious rollup grain (a daily/hourly summary).",
      "- Part counts high against row counts (small-write pressure), or a",
      "  partition key finer than the data warrants.",
      "Propose recommendations of category materialized_view, rollup,",
      "projection_index, schema_type or partitioning. Put real, copyable DDL in",
      "`proposedSql` (qualified db.table) — it is SHOWN to the reader, never run.",
      "Charts here are optional; a storage-savings or part-count bar is welcome",
      "but this lens is mostly recommendations.",
    ].join("\n"),
  },
  {
    id: "quality",
    label: "Distributions & data quality",
    whenToUse:
      "Almost always worth running. Null rates, cardinality, duplicates, " +
      "outliers, implausible values and the shape of each column's distribution.",
    brief: [
      "LENS: Distributions & data quality.",
      "Profile the columns that carry the meaning. Consider:",
      "- Null / empty rates on columns that should be populated.",
      "- Distributions that are lopsided, long-tailed, or spiked on a default",
      "  value (a sentinel like 0, -1, '1970-01-01', 'unknown').",
      "- Duplicate keys where uniqueness is implied.",
      "- Outliers and implausible values (negative amounts, future dates).",
      "- Cardinality that is surprising for what the column names itself.",
      "Charts: a histogram/distribution or a null-rate bar reads well here.",
      "Stats: null rates and distinct counts make good KPIs.",
      "Recommendations are usually new_metric (a data-quality check to watch) or",
      "schema_type when a column's values argue for a tighter type.",
    ].join("\n"),
  },
  {
    id: "trends",
    label: "Trends over time",
    whenToUse:
      "Run when the data has a usable date/time column. Growth, seasonality, " +
      "recent shifts, and the rhythm of the series over time.",
    brief: [
      "LENS: Trends over time.",
      "Find the primary date/time column and bucket the important measures over",
      "it (by day, week or month — pick the grain that gives a readable series).",
      "Consider:",
      "- Overall trajectory: growth, decline, a plateau, a step change.",
      "- Seasonality or a weekly/daily rhythm.",
      "- A recent shift versus the historical baseline.",
      "- Whether the most recent bucket is still filling (don't call a dip that is",
      "  just a partial period).",
      "Charts: line/area over time is the core deliverable — produce a few for the",
      "measures that matter. Stats: a headline total plus a period-over-period",
      "delta where you can compute one.",
      "Recommendations are usually new_metric (a trend worth a standing watcher)",
      "or rollup (a time-bucketed summary table).",
    ].join("\n"),
  },
  {
    id: "segments",
    label: "Segmentation & cohorts",
    whenToUse:
      "Run when the data has categorical dimensions worth breaking down by " +
      "(a category, region, type, status, customer). Concentration, top " +
      "segments, and how measures split across cohorts.",
    brief: [
      "LENS: Segmentation & cohorts.",
      "Break the key measures down by the dimensions that carry meaning.",
      "Consider:",
      "- Concentration: does a small share of segments carry most of the volume",
      "  (an 80/20)? Name the share.",
      "- The dominant and the long-tail segments.",
      "- A cross-tab where one dimension's behaviour differs sharply by another.",
      "- A cohort split (e.g. by signup period or first-seen bucket) if the data",
      "  supports it.",
      "Charts: ranked bars (set horizontal for long labels), a part-to-whole for",
      "a clean composition, a heatmap for a two-dimension cross-tab.",
      "Recommendations are usually new_metric (a segment worth tracking) or",
      "rollup (a per-segment summary).",
    ].join("\n"),
  },
  {
    id: "enrichment",
    label: "Joins & enrichment",
    whenToUse:
      "Run when more than one table is in scope, or when a single table clearly " +
      "references a dimension it doesn't hold (an id with no lookup, a code with " +
      "no label). The 'you have X, join Y to get Z' lens.",
    brief: [
      "LENS: Cross-table joins & enrichment.",
      "Find where joining or adding a table would unlock a richer metric.",
      "Consider:",
      "- If several tables are in scope: verify a real join key by probing the",
      "  overlap of value domains on both sides BEFORE asserting it, then show a",
      "  cross-table metric the join makes possible.",
      "- If one table is in scope: columns that reference something not present —",
      "  a foreign id with no lookup table, a code with no label, coordinates with",
      "  no place name. Name the table the reader is MISSING and the metric it",
      "  would unlock ('you have order rows keyed by product_id but no product",
      "  table — join it to get revenue by category').",
      "Charts: a cross-table finding, when a join is verified.",
      "Recommendations are category join_enrichment. Put the JOIN or a proposed",
      "CREATE DICTIONARY / lookup-table shape in `proposedSql` (shown, not run).",
      "Only assert a join you actually probed; say so in `evidence`.",
    ].join("\n"),
  },
  {
    id: "external",
    label: "Domain & external context",
    exploratory: true,
    whenToUse:
      "Run ONLY when the domain warrants outside context — a product catalog, a " +
      "public company, a market or geography the reader would benchmark against. " +
      "Do NOT run for internal telemetry, logs, or generic infrastructure data.",
    brief: [
      "LENS: Domain & external context (EXPLORATORY).",
      "Use web search to bring in context the dataset cannot contain about itself",
      "— competitors, market benchmarks, category norms, notable external events",
      "that would explain a pattern. This is speculative by construction:",
      "- Every recommendation you make here MUST set exploratory=true and belong",
      "  to category external.",
      "- Tie each point back to something concrete in the data where you can",
      "  ('your top category is X; the market leaders in X are …').",
      "- Do NOT invent numbers about the dataset itself — external context frames",
      "  the hard-data findings, it does not replace them.",
      "- proposedSql is usually empty here; the value is the framing, not DDL.",
      "You may still run read-only SQL to ground your framing in the actual data.",
    ].join("\n"),
  },
];

const BY_ID = new Map(LENSES.map((l) => [l.id, l]));

export function lens(id: LensId): Lens {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown lens "${id}".`);
  return found;
}

export function lensLabel(id: LensId): string {
  return BY_ID.get(id)?.label ?? id;
}

/** The lens menu as triage reads it — id, label and when each applies. */
export function renderLensMenu(): string {
  return LENSES.map(
    (l) => `- ${l.id} (${l.label})${l.exploratory ? " [exploratory]" : ""}: ${l.whenToUse}`,
  ).join("\n");
}

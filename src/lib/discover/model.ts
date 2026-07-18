/**
 * The discovery data model.
 *
 * Discovery takes a human-curated scope (a few tables worth looking at together)
 * and returns two things the findings board is built from:
 *
 *   1. a RELATIONSHIP MAP — how the scoped tables connect (structural, semantic
 *      or statistical), each edge verified against the data before it is trusted;
 *   2. a set of nominated FINDINGS — the cards the four verbs then operate on,
 *      single-table and cross-table, each carrying the runnable SQL that produces
 *      it so the board can re-run it live.
 *
 * These are Zod schemas so the agent's structured output is validated at the
 * boundary. Nothing here knows a table or column name — the shapes are the same
 * for a taxi dataset and a telemetry one. Server-safe and free of any client or
 * db import, so the UI can import the *types* (type-only) without pulling it in.
 */
import { z } from "zod";

/** How two tables were found to relate. All three signals are in play. */
export const RelationshipKind = z.enum(["structural", "semantic", "statistical"]);
export type RelationshipKind = z.infer<typeof RelationshipKind>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

/**
 * One edge of the relationship map. `on` is the key or axis the two tables align
 * on — a join key ("pickup_zone ↔ zone_id"), a shared grain, or a common
 * time/geo axis ("by day"). The rationale is one line the card can show, and the
 * confidence reflects how well a probe query actually backed the link up.
 */
export const Relationship = z.object({
  /** "database.table" — the id the scope uses. */
  a: z.string().min(1),
  b: z.string().min(1),
  kind: RelationshipKind,
  /** The key/axis the two align on, in the analyst's words. */
  on: z.string().min(1).max(140),
  /**
   * One concise line of why, e.g. "94% of taxi zones appear as tower zone ids".
   * Capped generously rather than tightly: a single long sentence must never
   * fail the whole run's schema — the prompt asks for brevity instead.
   */
  rationale: z.string().min(1).max(500),
  confidence: Confidence,
});
export type Relationship = z.infer<typeof Relationship>;

/**
 * A nominated finding — the content of one card.
 *
 * `sql` is an aggregated read-only SELECT the agent has run and trusts; the board
 * re-runs it live rather than caching a snapshot. By convention its first column
 * is the x (bucket/label/time) and its second is the y (the measure), so the
 * existing chart pipeline can shape it without a spec — `chartType`/`encodings`
 * only override. `tables` is which scoped tables it draws on: two means it is a
 * cross-table finding, computed over the discovered relationship.
 */
export const Finding = z.object({
  /** Stable kebab slug, e.g. "umts-concentration". */
  id: z.string().min(1).max(64),
  /** Short eyebrow naming the signal, e.g. "Concentration", "Cross-table · coupling". */
  signal: z.string().min(1).max(48),
  /** The scoped table ids this finding uses (1 = single-table, 2 = cross-table). */
  tables: z.array(z.string().min(1)).min(1).max(2),
  /** One sentence, specific: the thing the data nominated about itself. */
  finding: z.string().min(1).max(400),
  /** An aggregated, read-only ClickHouse SELECT. x = first column, y = second. */
  sql: z.string().min(1).max(4_000),
  /** Flint chart type (e.g. "Bar Chart", "Line Chart", "Pie Chart"); omit to infer. */
  chartType: z.string().max(40).optional(),
  /** channel → column, e.g. {"x":"day","y":"trips"}; omit to infer from shape. */
  encodings: z.record(z.string(), z.string()).optional(),
  /** 0–4: how surprising / worth-noticing. Ranks the board. */
  surprise: z.number().min(0).max(4),
});
export type Finding = z.infer<typeof Finding>;

/** What the agent produces: the map + the nominated findings (no data yet). */
export const DiscoveryResult = z.object({
  relationships: z.array(Relationship).max(12),
  findings: z.array(Finding).min(1).max(8),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;

/** A JSON value — what survives the run-metadata channel the board subscribes to. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A row of a finding's result. Column names are the analyst's, never ours. */
export type ResultRow = Record<string, JsonValue>;

/**
 * A finding after its SQL has been run: the card is self-contained, so the board
 * renders from embedded rows and never sends SQL from the browser. `error` is
 * set (and rows empty) when the finding's own query didn't come back.
 */
export type EnrichedFinding = Finding & {
  rows: ResultRow[];
  error: string | null;
};

/** The discovery result the board actually renders — findings carry their data. */
export type EnrichedDiscovery = {
  relationships: Relationship[];
  findings: EnrichedFinding[];
};

/** The curated scope handed to a discovery run. */
export const DiscoveryScope = z.object({
  /** One or more "database.table" ids. One table is a valid scope. */
  tables: z.array(z.string().min(1)).min(1).max(6),
  /** Optional plain-language nudge for what to surface first. */
  focus: z.string().max(400).optional(),
});
export type DiscoveryScope = z.infer<typeof DiscoveryScope>;

/** Realtime status a discovery run publishes as it works. */
export type DiscoveryStatus = "profiling" | "complete" | "failed";

/** The whole of a discovery run's metadata — what the board subscribes to. */
export type DiscoveryMetadata = {
  status: DiscoveryStatus;
  scope: DiscoveryScope;
  /** How many times the agent has probed the data so far (a progress tick). */
  probeCount?: number;
  /** Filled once the run completes; null while profiling. Findings carry rows. */
  result: EnrichedDiscovery | null;
  /** Present only when status is "failed". */
  error: string | null;
};

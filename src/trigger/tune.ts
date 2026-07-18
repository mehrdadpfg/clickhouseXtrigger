/**
 * Tune — the read → act shift.
 *
 * The chat agent reads. Watchers keep reading on a schedule. Tune is the first
 * feature that *changes* ClickHouse: it reads the query log, works out what
 * recurring work could be pre-computed, and — only once a human says yes —
 * creates the materialized view or projection that eliminates it.
 *
 *
 * WHY A WAIT TOKEN, NOT A "should I?" BOOLEAN
 * ------------------------------------------
 * The DDL this task runs is real and mutating. `CREATE MATERIALIZED VIEW` and
 * `ALTER TABLE … MATERIALIZE PROJECTION` write to the user's cluster, take
 * storage, and rebuild in the background. That must never happen because a
 * model proposed it — only because a person approved it.
 *
 * So the run does not decide. It proposes, publishes each proposal to run
 * metadata (which the Tune page renders), and then *pauses on a waitpoint token
 * per suggestion* (wait.forToken). It stays parked — costing nothing, holding
 * no connection — until someone completes that token from the UI. Approve and
 * the DDL runs; dismiss, or let it time out, and nothing is created. This is
 * the documented human-in-the-loop primitive, not a bespoke poll.
 *
 * The tokens never reach the browser. The page approves by suggestion id
 * through a server action, which looks the token up in this run's metadata and
 * completes it server-side — so the credential that can mutate the cluster
 * stays on the server.
 */
import { metadata, schemaTask, wait } from "@trigger.dev/sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { clickhouse } from "@/lib/clickhouse/client";
import { describeTable, type TableSchema } from "@/lib/clickhouse/introspect";
import { analyzeQueryLog, type QueryLogAnalysis } from "@/lib/clickhouse/queryLog";

// --- shapes shared with the reading side ----------------------------------

/**
 * A suggestion, as the model proposes it. The DDL arrives as an array of
 * whole statements: a projection needs two (ADD then MATERIALIZE), and keeping
 * them separate means each is validated and executed on its own rather than us
 * splitting a blob on semicolons and hoping.
 */
// Constraints are kept loose on purpose: generateObject rejects the whole
// response if any field trips a bound, so length caps on model-authored prose
// (a speedup phrase, a rationale) turn into "response did not match schema"
// failures. Types are pinned; sizes are advised in the prompt, not enforced.
const ProposedSuggestion = z.object({
  kind: z.enum(["materialized_view", "projection"]),
  /** The object being created — an identifier, e.g. `tips_by_zone_daily`. */
  name: z.string(),
  /** The user table it optimizes, as `database.table`. */
  targetTable: z.string(),
  /** A short human title for the card. */
  title: z.string(),
  /** What it pre-computes and which questions it serves, in one or two lines. */
  rationale: z.string(),
  /** How many of the recurring questions this covers. */
  questionsCovered: z.number(),
  /** Estimated added storage, phrased for a human, e.g. "+38 MB". */
  estStorage: z.string(),
  /** Estimated speedup, e.g. "0.42s → 12ms" or "skips 82% of the scan". */
  estSpeedup: z.string(),
  /** The real DDL, one statement per element, run in order after approval. */
  statements: z.array(z.string()).min(1),
  /** normalized_query_hash values this optimization would serve. */
  coversHashes: z.array(z.string()).optional(),
});

const ProposalResult = z.object({
  /** One or two sentences summarising the finding, shown above the cards. */
  finding: z.string(),
  suggestions: z.array(ProposedSuggestion),
});

export type SuggestionStatus = "pending" | "applied" | "failed" | "dismissed";

/** A suggestion as it lives in run metadata, with its lifecycle attached. */
export type SuggestionState = z.infer<typeof ProposedSuggestion> & {
  /** Stable within the run — what the UI addresses to approve/dismiss. */
  id: string;
  /** The waitpoint token this suggestion is parked on. Server-only; never sent to a browser. */
  tokenId: string;
  status: SuggestionStatus;
  /** Present when status is "failed" — the ClickHouse error. */
  error?: string;
  decidedAt?: string;
};

export type TuneStatus =
  | "analyzing"
  | "proposing"
  | "awaiting_approval"
  | "done";

/** The whole of a tune run's metadata. The page reads exactly this. */
export type TuneMetadata = {
  status: TuneStatus;
  windowDays: number;
  finding: string | null;
  analysis: QueryLogAnalysis | null;
  suggestions: SuggestionState[];
};

/** What a completed approval token carries. */
export type TuneApproval = { approved: boolean };

// --- DDL guard -------------------------------------------------------------

/**
 * The last line of defence before a statement runs against the cluster.
 *
 * Approval already gates every statement; this is belt-and-braces on top. Only
 * the two optimization shapes Tune exists to create are allowed through —
 * everything else (a DROP TABLE, a DELETE, a second statement smuggled past a
 * semicolon) is refused before it reaches ClickHouse, however it got proposed.
 */
function assertOptimizationDdl(statement: string): void {
  const s = statement
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");

  if (s.includes(";")) {
    throw new Error("Refusing DDL with more than one statement.");
  }

  const isCreateMv = /^create\s+materialized\s+view\b/i.test(s);
  const isProjection =
    /^alter\s+table\s+[\w.`]+\s+(add|materialize|drop)\s+projection\b/i.test(s);

  if (!isCreateMv && !isProjection) {
    throw new Error(
      "Refusing DDL that is not a MATERIALIZED VIEW or a PROJECTION change.",
    );
  }

  // Even within an allowed prefix, refuse the destructive verbs outright.
  // (DROP PROJECTION is a projection change and stays allowed — that is revert.)
  if (
    /\b(drop\s+(table|database|dictionary|view)|truncate|delete\s+from|insert\s+into|attach|detach|rename|grant|revoke|optimize\s+table)\b/i.test(
      s,
    )
  ) {
    throw new Error("Refusing DDL containing a destructive statement.");
  }
}

// --- schema context for the model -----------------------------------------

/** Compact, model-facing description of one table — enough to write correct DDL. */
function renderSchema(schema: TableSchema): string {
  const cols = schema.columns
    .map((c) => `    ${c.name} ${c.type}${c.comment ? ` -- ${c.comment}` : ""}`)
    .join("\n");
  return [
    `${schema.database}.${schema.name} (engine ${schema.engine}, ${
      schema.rows ?? "?"
    } rows)`,
    `  ORDER BY: ${schema.sortingKey || "(none)"}`,
    `  columns:`,
    cols,
  ].join("\n");
}

/** Introspect every table the top patterns touch, so DDL is written against the live schema. */
async function schemasForPatterns(
  analysis: QueryLogAnalysis,
): Promise<TableSchema[]> {
  const seen = new Set<string>();
  for (const pattern of analysis.patterns) {
    for (const table of pattern.tables) seen.add(table);
  }

  const schemas = await Promise.all(
    [...seen].map(async (qualified) => {
      const dot = qualified.indexOf(".");
      if (dot < 0) return null;
      const database = qualified.slice(0, dot);
      const table = qualified.slice(dot + 1);
      return describeTable(database, table).catch(() => null);
    }),
  );

  return schemas.filter((s): s is TableSchema => s !== null);
}

// --- the prompt ------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a ClickHouse performance engineer. You are given the recurring,",
  "expensive SELECT patterns from a database's query log, and the live schema",
  "of the tables they read. Propose what to MATERIALIZE so those questions",
  "return faster: ClickHouse MATERIALIZED VIEWs (with an AggregatingMergeTree /",
  "SummingMergeTree target and *State aggregate functions where pre-aggregating)",
  "and/or PROJECTIONs (for filter/order patterns that a re-sorted copy would",
  "let ClickHouse skip parts of).",
  "",
  "Rules:",
  "- Write REAL, executable ClickHouse DDL against the schema you are given.",
  "  Never invent columns — use only columns present in the provided schema.",
  "- Qualify every object with its database (db.name).",
  "- A PROJECTION is two statements: ALTER TABLE … ADD PROJECTION, then",
  "  ALTER TABLE … MATERIALIZE PROJECTION. Return them as two array elements.",
  "- A MATERIALIZED VIEW is one CREATE MATERIALIZED VIEW … statement. Prefer an",
  "  explicit target engine and, when the queries aggregate, AggregatingMergeTree",
  "  with *State functions.",
  "- Only propose an optimization that genuinely serves one or more of the given",
  "  patterns. Prefer a few high-coverage suggestions over many marginal ones.",
  "- Emit only MATERIALIZED VIEW creations and PROJECTION add/materialize",
  "  statements — nothing else (no DROP/DELETE/INSERT/TRUNCATE).",
  "- Estimate speedup and storage honestly from the evidence's row counts and",
  "  scan sizes, phrased TERSELY like a dashboard chip (estSpeedup \"145ms → ~3ms\",",
  "  estStorage \"+38 MB\"). Longer justification goes in `rationale`, not the estimates.",
  "- `finding`: two or three sentences, plain language, no SQL.",
  "- `title`: a short human name for the card (a few words).",
].join("\n");

function renderEvidence(analysis: QueryLogAnalysis): string {
  return analysis.patterns
    .map((p, i) => {
      const mb = (p.totalReadBytes / 1_000_000).toFixed(1);
      return [
        `Pattern ${i + 1} [hash ${p.queryHash}]`,
        `  ran ${p.count}× over ${p.daysActive} day(s), avg ${p.avgDurationMs}ms, ` +
          `total ${p.totalReadRows.toLocaleString()} rows / ${mb} MB read`,
        `  tables: ${p.tables.join(", ")}`,
        `  query: ${p.sampleQuery}`,
      ].join("\n");
    })
    .join("\n\n");
}

// --- the task --------------------------------------------------------------

const TunePayload = z.object({
  /** How far back the query-log analysis looks. Defaults to 14 days. */
  windowDays: z.number().int().positive().max(90).optional(),
  /** How many top patterns to feed the model. Defaults to 10. */
  patternLimit: z.number().int().positive().max(30).optional(),
});

export const tuneTask = schemaTask({
  id: "tune",
  schema: TunePayload,
  // The run spends almost all of its wall-clock parked on approval waitpoints,
  // which do not consume compute. This bounds the active work (analysis, the
  // model call, and the DDL itself, which can rebuild in the background).
  maxDuration: 3600,
  // Re-analysing and re-proposing on a retry would strand the first attempt's
  // waitpoints and could double-create. One attempt; the user re-runs from the
  // page if the analysis itself failed.
  retry: { maxAttempts: 1 },

  run: async (payload) => {
    const windowDays = payload.windowDays ?? 14;

    const initial: TuneMetadata = {
      status: "analyzing",
      windowDays,
      finding: null,
      analysis: null,
      suggestions: [],
    };
    metadata.replace(initial);

    // 1. Read the history.
    const analysis = await analyzeQueryLog({
      windowDays,
      limit: payload.patternLimit ?? 10,
    });
    metadata.set("analysis", analysis);

    if (analysis.patterns.length === 0) {
      metadata.set("status", "done").set(
        "finding",
        "No recurring queries against your tables in this window — nothing to materialize yet.",
      );
      return { windowDays, suggestions: 0, applied: 0 };
    }

    // 2. Discover the live schema of the tables involved, then propose.
    metadata.set("status", "proposing");
    const schemas = await schemasForPatterns(analysis);

    const { object } = await generateObject({
      model: anthropic("claude-sonnet-5"),
      schema: ProposalResult,
      // The DDL for several suggestions is long; a tight budget truncates the
      // JSON and reads back as a schema mismatch. Give it room.
      maxOutputTokens: 8000,
      system: SYSTEM_PROMPT,
      prompt: [
        `Query window: last ${windowDays} days.`,
        `${analysis.totalQueries} matching queries across ${analysis.distinctPatterns} distinct patterns.`,
        "",
        "== Recurring patterns (heaviest first) ==",
        renderEvidence(analysis),
        "",
        "== Live schema of the tables involved ==",
        schemas.map(renderSchema).join("\n\n") || "(schema unavailable)",
        "",
        "Propose the optimizations. Return the finding summary and the suggestions.",
      ].join("\n"),
    });

    // 3. Park each suggestion on its own approval token, and publish the set.
    const states: SuggestionState[] = await Promise.all(
      // At most five — the page is a shortlist, not a backlog.
      object.suggestions.slice(0, 5).map(async (suggestion, index) => {
        const token = await wait.createToken({
          timeout: "24h",
          tags: [`tune-suggestion:${index}`],
        });
        return {
          ...suggestion,
          coversHashes: suggestion.coversHashes ?? [],
          id: `s${index}`,
          tokenId: token.id,
          status: "pending" as const,
        };
      }),
    );

    metadata
      .set("finding", object.finding)
      .set("suggestions", states)
      .set("status", "awaiting_approval");

    if (states.length === 0) {
      metadata.set("status", "done");
      return { windowDays, suggestions: 0, applied: 0 };
    }

    // 4. Wait — in parallel — for each decision. The run parks here; each
    //    callback resolves when its token is completed (approve/dismiss) or
    //    times out. `states` is a single shared array in this one process, so
    //    each callback mutates its own entry and re-publishes the whole set;
    //    JS's single thread makes those writes safe without a lock.
    await Promise.all(
      states.map(async (state) => {
        const result = await wait.forToken<TuneApproval>(state.tokenId);
        const approved = result.ok && result.output.approved === true;
        state.decidedAt = new Date().toISOString();

        if (!approved) {
          // Rejected, or the token timed out — either way nothing is created.
          state.status = "dismissed";
          metadata.set("suggestions", states);
          return;
        }

        try {
          for (const statement of state.statements) {
            assertOptimizationDdl(statement);
            // The one mutating path in the app. No readonly settings — this is
            // DDL, and it only runs because a human completed the token above.
            await clickhouse.command({ query: statement });
          }
          state.status = "applied";
        } catch (cause) {
          state.status = "failed";
          state.error =
            cause instanceof Error ? cause.message : "Failed to apply.";
        }
        metadata.set("suggestions", states);
      }),
    );

    metadata.set("status", "done");

    return {
      windowDays,
      suggestions: states.length,
      applied: states.filter((s) => s.status === "applied").length,
    };
  },
});

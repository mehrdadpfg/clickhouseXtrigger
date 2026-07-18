/**
 * Running a discovery pass over a curated scope.
 *
 * This is the agentic heart of Explore. Given the tables the human chose to look
 * at together, it hands the agent their live schemas plus a read-only query tool
 * and asks it to do two things it can only do by *looking at the data*:
 *
 *   1. work out how the tables relate — structurally (shared/joinable keys),
 *      semantically (names that mean the same thing), and statistically (a shared
 *      time or geo axis, coupled series) — and VERIFY each candidate link with a
 *      probe query before asserting it;
 *   2. nominate the findings worth a card, single-table and cross-table, each
 *      with the aggregated SQL that produces it.
 *
 * The math a finding rests on is deterministic SQL; what the agent adds is the
 * dataset-agnostic part — which columns, how to bucket, what it means — which is
 * exactly why this is agentic and not a fixed template. The structured result is
 * validated against the discovery model at the tool boundary.
 *
 * Lib, server-only: it reaches ClickHouse directly, exactly like the compare
 * planner. The Trigger task is a thin durable wrapper around this function.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool, Output } from "ai";
import { z } from "zod";
import { runReadonlyQuery } from "@/lib/clickhouse/run";
import { describeTable, type TableSchema } from "@/lib/clickhouse/introspect";
import {
  DiscoveryResult,
  DiscoveryScope,
  type EnrichedFinding,
  type Finding,
  type ResultRow,
} from "./model";

/** "database.table" → its parts. Tolerates a bare name (defaults db to "default"). */
export function splitId(id: string): { database: string; name: string } {
  const dot = id.indexOf(".");
  if (dot === -1) return { database: "default", name: id };
  return { database: id.slice(0, dot), name: id.slice(dot + 1) };
}

/** Describe every scoped table, dropping any that can't be introspected. */
export async function describeScope(tables: string[]): Promise<TableSchema[]> {
  const schemas = await Promise.all(
    tables.map((id) => {
      const { database, name } = splitId(id);
      return describeTable(database, name);
    }),
  );
  return schemas.filter((s): s is TableSchema => s !== null);
}

/** A compact, agent-readable rendering of one table's live schema. */
export function renderSchema(schema: TableSchema): string {
  const head = `TABLE ${schema.database}.${schema.name}` +
    (schema.rows !== null ? `  (~${schema.rows.toLocaleString("en-US")} rows)` : "") +
    (schema.sortingKey ? `  ORDER BY ${schema.sortingKey}` : "");
  const cols = schema.columns
    .map((c) => `  ${c.name} ${c.type}${c.comment ? `  -- ${c.comment}` : ""}`)
    .join("\n");
  const note = schema.comment ? `\n  # ${schema.comment}` : "";
  return `${head}${note}\n${cols}`;
}

const SYSTEM = [
  "You are a senior data analyst profiling a ClickHouse scope for a tool called Vantage.",
  "The user curated a SCOPE (a few tables to look at together) and wants the board already full of things the data nominated about itself. You do the nominating.",
  "",
  "You are given each scoped table's live schema. You also have a `queryClickhouse` tool to run read-only aggregate SQL. USE IT to look before you assert — never guess a number, an overlap, or a distribution.",
  "",
  "Produce two things:",
  "",
  "A. RELATIONSHIPS — how the scoped tables connect. Consider all three signals:",
  "   - structural: columns of compatible type whose VALUE DOMAINS overlap (a join key). Verify by probing overlap, e.g. count distinct matches / cardinality on both sides. Do not claim a join you haven't checked.",
  "   - semantic: columns that MEAN the same thing under different names (lat/lon vs geohash, ts vs event_time). Say so, and if they can be aligned (e.g. via a bucket), note the axis.",
  "   - statistical: a shared time or geo axis, or two series that move together. Verify by bucketing both to a common grain and eyeballing the overlap.",
  "   Set confidence from how well your probe backed the link. If the scope is a single table, relationships is empty. Keep each `rationale` to one concise line.",
  "",
  "B. FINDINGS — 4 to 7 cards, ranked by surprise (0–4). Mix of:",
  "   - single-table signals: a lopsided concentration, a dominant category, a long-tailed distribution, a non-obvious trend or rhythm, an outlier, a strong association between two columns.",
  "   - CROSS-TABLE findings when a relationship exists: correlate a measure from one table against a dimension/axis from the other, joined or aligned on the discovered key/axis. Prefer at least one cross-table finding whenever the scope has a real relationship.",
  "   Each finding needs: a short `signal` eyebrow; the `tables` it uses (1 or 2 ids); a ONE-SENTENCE `finding` naming the specific thing (with the number that makes it land); and `sql`.",
  "",
  "SQL rules (every finding.sql):",
  "- A single read-only ClickHouse SELECT/WITH. No DDL/DML, no semicolons chaining, no FORMAT.",
  "- AGGREGATE — the table is large; never select raw rows. Return a small result (a handful to a few dozen rows).",
  "- Projection convention so the card can chart it without a spec: the FIRST column is the x (a bucket, label, or time), the SECOND is the y (the measure). A part-to-whole finding is (category, value). A single scalar is one row, one column.",
  "- Qualify every table as database.table. Only use columns that appear in the schemas you were given.",
  "- For a cross-table finding, JOIN or align the two tables on the relationship's key/axis.",
  "- Set `chartType` (e.g. \"Bar Chart\", \"Line Chart\", \"Pie Chart\", \"Scatter Plot\") for the finding. When you set a chartType you MUST also set `encodings` mapping each channel to a column ALIAS in your SELECT's projection — e.g. {\"x\":\"hr\",\"y\":\"n\"} for a line, {\"color\":\"payment_type\",\"size\":\"n\"} for a pie, {\"x\":\"taxi_n\",\"y\":\"tower_n\"} for a scatter. Do not leave encodings empty.",
  "",
  "Keep findings genuinely different from each other. Report the surprise honestly — not everything is a 4.",
].join("\n");

/**
 * Run discovery for a scope. Returns the validated relationship map + findings.
 *
 * `onProbe` (optional) is called with each SQL the agent runs, so a caller can
 * surface progress. Errors from a probe are swallowed into the tool result so a
 * bad guess costs the agent a step, not the whole run.
 */
export async function runDiscovery(
  input: DiscoveryScope,
  onProbe?: (sql: string) => void,
): Promise<DiscoveryResult> {
  const scope = DiscoveryScope.parse(input);

  // Deterministic introspection up front — cheaper and more reliable than making
  // the agent spend turns rediscovering the schema it could just be handed.
  const schemas = (
    await Promise.all(
      scope.tables.map((id) => {
        const { database, name } = splitId(id);
        return describeTable(database, name);
      }),
    )
  ).filter((s): s is TableSchema => s !== null);

  if (schemas.length === 0) {
    throw new Error("None of the scoped tables could be described.");
  }

  const schemaText = schemas.map(renderSchema).join("\n\n");
  const focusLine = scope.focus
    ? `\n\nThe analyst is especially curious about: "${scope.focus}". Let it tilt what you surface first, but still report the strongest signals even if they're off that thread.`
    : "";

  const queryClickhouse = tool({
    description:
      "Run a read-only ClickHouse SELECT to probe a relationship or compute a " +
      "candidate finding. Aggregate; add a LIMIT when sampling. Returns the rows.",
    inputSchema: z.object({
      sql: z
        .string()
        .describe(
          "One ClickHouse SELECT, qualified db.table, no trailing semicolon, no FORMAT.",
        ),
    }),
    execute: async ({ sql }) => {
      onProbe?.(sql);
      try {
        const rows = await runReadonlyQuery(sql);
        // Guard the context: a probe should be an aggregate, but cap regardless.
        return { rows: rows.slice(0, 50), rowCount: rows.length };
      } catch (cause) {
        return {
          error: cause instanceof Error ? cause.message : "Query failed.",
        };
      }
    },
  });

  const userPrompt =
    `Scoped tables:\n\n${schemaText}${focusLine}\n\n` +
    "Probe as needed, then return the relationship map and the nominated findings.";

  // Prompt caching: the system prompt, the tool schemas and this schema dump are
  // IDENTICAL on every one of the (up to 16) tool-loop steps — only the growing
  // probe transcript changes. Anthropic assembles the request as tools → system →
  // messages, so one ephemeral breakpoint on this first user message caches that
  // whole static prefix; after the first step it's read from cache instead of
  // re-billed, which is where most of a discovery's token cost lives.
  const { output } = await generateText({
    model: anthropic("claude-sonnet-5"),
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: userPrompt,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" as const } },
        },
      },
    ],
    tools: { queryClickhouse },
    // Enough steps to probe several links and findings before emitting output.
    stopWhen: stepCountIs(16),
    output: Output.object({ schema: DiscoveryResult }),
  });

  return output;
}

/**
 * Run each finding's SQL and embed the rows, so the board renders a finding from
 * data it already holds rather than sending SQL back from the browser. A finding
 * whose query fails is kept but marked — a failed card is honest; a dropped one
 * silently narrows the board. Rows are capped: a finding is an aggregate, not a
 * dump, and the card only needs enough to draw.
 */
export async function executeFindings(
  findings: Finding[],
): Promise<EnrichedFinding[]> {
  return Promise.all(
    findings.map(async (finding) => {
      try {
        // ClickHouse hands back arbitrary JSON per row; treat it as such.
        const rows = (await runReadonlyQuery(finding.sql)) as ResultRow[];
        return { ...finding, rows: rows.slice(0, 200), error: null };
      } catch (cause) {
        return {
          ...finding,
          rows: [],
          error: cause instanceof Error ? cause.message : "Query failed.",
        };
      }
    }),
  );
}

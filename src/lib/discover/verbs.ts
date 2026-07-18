/**
 * The four verbs.
 *
 * Every finding carries the same four questions. Clicking one runs a small
 * agentic pass over the live data — the agent writes the stat SQL for that verb
 * — and returns another finding (the child card in the "walk"). The math each
 * verb rests on is a named, deterministic statistic; what the agent supplies is
 * the dataset-agnostic part: which columns, how to bucket, and what it means.
 *
 * Same engine as discovery (generateText + a read-only query tool + structured
 * output), reusing its schema helpers. Lib, server-only.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool, Output } from "ai";
import { z } from "zod";
import { runReadonlyQuery } from "@/lib/clickhouse/run";
import { describeScope, renderSchema } from "./discover";
import { RelationshipKind, VerbKey, VerbResult } from "./model";

/** What a verb run is handed: the parent finding + the scope it lives in. */
export const VerbInput = z.object({
  verb: VerbKey,
  finding: z.object({
    signal: z.string().min(1),
    finding: z.string().min(1),
    sql: z.string().min(1),
    tables: z.array(z.string().min(1)).min(1),
    chartType: z.string().optional(),
  }),
  /** Every scoped table id, so a cross-table verb can reach the other table. */
  scope: z.array(z.string().min(1)).min(1).max(6),
  /** The discovered relationship map, for context on cross-table joins. */
  relationships: z
    .array(
      z.object({
        a: z.string(),
        b: z.string(),
        on: z.string(),
        kind: RelationshipKind,
      }),
    )
    .optional(),
});
export type VerbInput = z.infer<typeof VerbInput>;

/** Label, sub-label, and the statistical recipe the agent implements. */
export const VERBS: Record<
  VerbKey,
  { label: string; subtitle: string; recipe: string }
> = {
  why: {
    label: "Why?",
    subtitle: "Moves with",
    recipe: [
      "VERB — Why? Find what this finding MOVES WITH.",
      "Identify the finding's key dimension D (from its SQL/prose). Measure how strongly each OTHER column associates with D:",
      "- two categoricals → Cramér's V from a contingency table: sqrt( chi2 / n / min(rows-1, cols-1) ).",
      "- numeric vs numeric → abs(corr).",
      "- numeric vs categorical → the correlation ratio (eta).",
      "Rank the other columns by association (0..1) and return the top ~6 as (column, strength). A cross-table verb also tests columns from the related table, joined on the discovered key.",
      "Chart: Bar Chart, encodings {x: column, y: strength}. finding = name the single strongest driver and its strength. No verdict.",
    ].join("\n"),
  },
  disagree: {
    label: "Who disagrees?",
    subtitle: "Robustness",
    recipe: [
      "VERB — Who disagrees? Test the finding's ROBUSTNESS with a specification curve.",
      "Re-compute the finding's headline metric under many reasonable specifications a careful analyst might pick — different filters, time windows, subsamples, or groupings. Aim for 15-40 specs.",
      "Return (spec_label, value) ordered by value so the spread reads as a specification curve. Chart: Bar Chart, encodings {x: spec_label, y: value}.",
      "Judge how often the finding's claim/direction survives. verdict.label like 'HOLDS 34/40'; verdict.tone 'ok' if it mostly holds, 'soft' if mixed, 'bad' if it often flips; verdict.note = one line.",
      "finding = is the pattern robust, or an artifact of one framing.",
    ].join("\n"),
  },
  shape: {
    label: "Same shape?",
    subtitle: "Nearest neighbours",
    recipe: [
      "VERB — Same shape? Find the series with the NEAREST SHAPE.",
      "Take the finding's series (its value across its buckets/x). Find the OTHER columns or series in scope — including the related table — whose distribution shape is closest. Bucket each candidate the same way, normalise to a vector, and rank by cosine similarity (ClickHouse cosineDistance; similarity = 1 - distance) or the correlation of the shape vectors.",
      "Return the top ~5 as (series_name, similarity 0..1). Chart: Bar Chart, encodings {x: series_name, y: similarity}.",
      "finding = name the closest-shaped series and the similarity. No verdict.",
    ].join("\n"),
  },
  weird: {
    label: "What's weird?",
    subtitle: "Unexplained",
    recipe: [
      "VERB — What's weird? Surface the UNEXPLAINED residual.",
      "Take the finding's series. Remove the expected structure — subtract a moving average / the group mean / a simple fitted trend — to get residuals. Flag points beyond Tukey fences (below Q1 - 1.5*IQR or above Q3 + 1.5*IQR of the residuals).",
      "Return the residual series (x, residual) — Chart: Bar Chart, encodings {x, y: residual} — or the top outliers as (label, residual).",
      "verdict.label 'OUTLIER' (tone 'soft') when one clearly breaks the fence, else 'NO OUTLIER' (tone 'ok').",
      "finding = name the point the trend can't explain, or say nothing stands out.",
    ].join("\n"),
  },
};

const SYSTEM = [
  "You are a data analyst. Another pass already surfaced a FINDING; your job is to answer ONE follow-up question about it (a 'verb') by looking at the live data.",
  "You have the scoped tables' schemas and a read-only queryClickhouse tool. Probe before you assert — never guess a number.",
  "Return a child card: a short `signal` eyebrow, a ONE-SENTENCE `finding` (with the number that lands), the aggregated `sql` you ran, and a chart. Add a `verdict` only when the verb asks for one.",
  "`chartType` MUST be an exact name: \"Bar Chart\", \"Line Chart\", \"Pie Chart\", or \"Scatter Plot\" (not \"bar_horizontal\" or any variant). Always set `encodings` mapping each channel to a column alias in your SQL, e.g. {\"x\":\"metric\",\"y\":\"strength\"} — never leave it empty.",
  "SQL rules: one read-only ClickHouse SELECT/WITH, aggregated (never raw rows), first column = x, second = y; qualify db.table; use only columns in the schemas; a cross-table answer JOINs/aligns on the discovered key/axis.",
  "Keep to a handful of probes — you need the ranking/shape, not an exhaustive sweep of every column.",
].join("\n");

/** Run one verb against a finding. Returns the validated child card (no rows). */
export async function runVerb(
  input: VerbInput,
  onProbe?: (sql: string) => void,
): Promise<VerbResult> {
  const parsed = VerbInput.parse(input);
  const schemas = await describeScope(parsed.scope);
  if (schemas.length === 0) {
    throw new Error("None of the scoped tables could be described.");
  }

  const schemaText = schemas.map(renderSchema).join("\n\n");
  const relText =
    parsed.relationships && parsed.relationships.length > 0
      ? "\n\nDiscovered relationships:\n" +
        parsed.relationships
          .map((r) => `- ${r.a} ⇄ ${r.b} on ${r.on} (${r.kind})`)
          .join("\n")
      : "";

  const verb = VERBS[parsed.verb];
  const parent = parsed.finding;
  const userPrompt = [
    `Scoped tables:\n\n${schemaText}${relText}`,
    "",
    `PARENT FINDING — ${parent.signal}: ${parent.finding}`,
    `Its SQL:\n${parent.sql}`,
    "",
    verb.recipe,
    "",
    "Probe with queryClickhouse to compute the statistic, then return the child card.",
  ].join("\n");

  const queryClickhouse = tool({
    description:
      "Run a read-only ClickHouse SELECT to compute the statistic. Aggregate; " +
      "add a LIMIT when sampling. Returns the rows.",
    inputSchema: z.object({
      sql: z
        .string()
        .describe("One ClickHouse SELECT, qualified db.table, no trailing semicolon."),
    }),
    execute: async ({ sql }) => {
      onProbe?.(sql);
      try {
        const rows = await runReadonlyQuery(sql);
        return { rows: rows.slice(0, 50), rowCount: rows.length };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Query failed." };
      }
    },
  });

  const { output } = await generateText({
    model: anthropic("claude-sonnet-5"),
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: userPrompt,
        // Cache the static prefix (system + tools + schema + parent) across the
        // verb's own tool-loop steps.
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" as const } },
        },
      },
    ],
    tools: { queryClickhouse },
    stopWhen: stepCountIs(12),
    output: Output.object({ schema: VerbResult }),
  });

  return output;
}

/**
 * Planning a multivariant comparison.
 *
 * Given the base question and the exact SQL that answered it, an LLM proposes a
 * few VARIANTS — the same metric under different framings (a filter, a window, a
 * segment) — each as a modified copy of the base SQL. The compare fork then runs
 * each variant as its own durable branch.
 *
 * This is the one place that turns a plain-language "vary it by X" into SQL, so
 * it lives in lib and is only ever reached from the compare server action. It
 * never touches a table name of its own: every variant is derived from the base
 * SQL it is handed, so the feature stays dataset-agnostic.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

const Variant = z.object({
  /** Short tile name, e.g. "Weekends only", "Excl. airport", "Prev 30 days". */
  label: z.string().min(1).max(60),
  /** The varied value, optional — a longer gloss than the label. */
  description: z.string().max(120).optional(),
  /** A modified copy of the base SQL: one read-only ClickHouse statement. */
  sql: z.string().min(1),
});
export type PlannedVariant = z.infer<typeof Variant>;

const Plan = z.object({
  /** Names the y value, e.g. "Avg tip". */
  metricLabel: z.string().min(1).max(60),
  /** "$" | "%" | "×" when the number wears a unit; omitted otherwise. */
  unit: z.string().max(4).optional(),
  /** The dimension varied across the set, e.g. "trip filter". */
  varying: z.string().min(1).max(60),
  variants: z.array(Variant).min(2).max(3),
});
export type ComparePlan = z.infer<typeof Plan>;

const RULES = [
  'You design "multivariant" comparisons for a ClickHouse analytics chat.',
  "You are given a base question and the exact SQL that answered it. Propose variants that make a GENUINELY INFORMATIVE comparison — each a modified copy of the base SQL, run side by side on one shared scale.",
  "",
  "FIRST, classify the base by what its query returns, and comparison accordingly:",
  "- TREND or SCALAR (y is one aggregate over a time/numeric x, or a single number): vary a filter, time window, segment, or assumption — the SAME metric under a different framing. Keep the projection shape (x, y); a scalar base stays scalar.",
  "- DISTRIBUTION / BREAKDOWN / MIX (y is a share or count across a set of CATEGORIES on x — e.g. a payment-type split, a radio-type mix, a per-country breakdown): do NOT collapse it to a scalar (that flattens every tile to one meaningless number). Instead KEEP the full category series (same x categories, same y measure) and vary the POPULATION/SCOPE each mix is computed over — a different segment, region, tier, or time window — so the tiles compare the mix's SHAPE. Pick a scope dimension that actually CHANGES the mix (e.g. a radio mix in Top-5 vs mid-tier vs all countries; a payment mix on weekdays vs weekends), not one that leaves it identical.",
  "",
  "Hard rules:",
  "- Every variant.sql is a SINGLE read-only ClickHouse SELECT/WITH statement — a modified version of the base SQL. No DDL/DML, no second statement, no trailing semicolon chaining.",
  "- Keep the SAME projection shape as the base query (same columns, same order): first column = x (bucket/label/category/timestamp), second = y (the measure).",
  "- Every variant must return a series whose y actually VARIES — a real trend or distribution, never a flat constant or all-zeros. If varying the base as-written would flatten it, that is the wrong dimension: choose a different, meaningful one so the comparison is informative.",
  "- Only reference tables and columns that ALREADY appear in the base SQL. Never invent a column or a table.",
  "- Propose 3 variants — enough to read as a set, not so many they crowd. Each is a genuinely different framing, not a cosmetic re-label; each label is short (e.g. 'Weekends only', 'Top 5 countries').",
  "- metricLabel names the y; unit is '$'/'%'/'×' only when it truly applies, else omit; varying names the dimension you varied across the whole set.",
].join("\n");

/** Plan a whole comparison: the shared framing plus 2–4 variant SQLs. */
export async function planCompare(
  question: string,
  baseSql: string,
): Promise<ComparePlan> {
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-5"),
    schema: Plan,
    system: RULES,
    prompt: `Base question:\n${question}\n\nBase SQL:\n${baseSql}\n\nDesign the comparison.`,
  });
  return object;
}

/** Specialise ONE variant from a plain-language change the analyst typed. */
export async function specializeVariant(
  baseSql: string,
  change: string,
): Promise<PlannedVariant> {
  const { object } = await generateObject({
    model: anthropic("claude-sonnet-5"),
    schema: Variant,
    system: RULES,
    prompt: `Base SQL:\n${baseSql}\n\nProduce ONE variant that applies this change: "${change}". Keep the same projection shape; only reference tables and columns present in the base SQL.`,
  });
  return object;
}

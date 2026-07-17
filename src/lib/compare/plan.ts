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
  variants: z.array(Variant).min(2).max(4),
});
export type ComparePlan = z.infer<typeof Plan>;

const RULES = [
  'You design "multivariant" comparisons for a ClickHouse analytics chat.',
  "You are given a base question and the exact SQL that answered it. Propose variants of the SAME question — the same metric measured under a different framing (a filter, a time window, a segment, an assumption). Each variant is a modified copy of the base SQL.",
  "",
  "Hard rules:",
  "- Every variant.sql is a SINGLE read-only ClickHouse SELECT/WITH statement — a modified version of the base SQL. No DDL/DML, no second statement, no trailing semicolon chaining.",
  "- Keep the SAME projection shape as the base query (same columns, same order): the first column is the x (a bucket/label/timestamp), the second is the y (the measure). A scalar (one row, one column) base stays scalar.",
  "- Only reference tables and columns that ALREADY appear in the base SQL. Never invent a column or a table — if you are unsure a column exists, do not use it.",
  "- Variants must be genuinely different framings, not cosmetic re-labels. Each label is short (e.g. 'Weekends only').",
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

"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@trigger.dev/sdk";
import { z } from "zod";
import { forkCompare, type CompareBase, type CompareVariant } from "@/trigger/compare";
import { planCompare, specializeVariant } from "@/lib/compare/plan";
import { addTile, createBoard } from "@/lib/db/boards";

/**
 * The Compare (multivariant) surface's writes.
 *
 * A "Compare" click forks the answer's question into several durable branch runs
 * — the same metric under different framings — and the browser watches them fill
 * in. These actions are the seam: they plan the variants (LLM → SQL), fan them
 * out via forkCompare (batchTrigger), and mint a tag-scoped token the client
 * subscribes with. Nothing here interpolates caller SQL into a new statement; a
 * variant's SQL is produced by the planner from the base SQL and replayed behind
 * readonly=2 by the branch task.
 */

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

function fail(error: string): Err {
  return { ok: false, error };
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** Trim a would-be unit down to what CompareBase accepts, or drop it. */
function cleanUnit(unit?: string): string | undefined {
  const u = unit?.trim();
  return u && u.length <= 4 ? u : undefined;
}

const Base = z.object({
  question: z.string().min(1),
  metricLabel: z.string().min(1),
  unit: z.string().max(4).optional(),
  varying: z.string().min(1),
});

const StartInput = z.object({
  question: z.string().trim().min(1).max(400),
  sql: z.string().trim().min(1).max(8_000),
});

/** A variant as the client first renders it — identity + colour, no SQL. */
export interface VariantSeed {
  id: string;
  label: string;
  description?: string;
  colorSlot: number;
}

/**
 * Plan a comparison from an answer, fork its variants, and hand back what the
 * sidebar needs to render and subscribe: the shared base, the seed branches, and
 * a token scoped to just this session's runs.
 */
export async function startCompareAction(
  input: unknown,
): Promise<Ok<{
  sessionId: string;
  sessionTag: string;
  accessToken: string;
  base: CompareBase;
  variants: VariantSeed[];
}> | Err> {
  const parsed = StartInput.safeParse(input);
  if (!parsed.success) return fail("Nothing to compare.");
  const { question, sql } = parsed.data;

  try {
    const plan = await planCompare(question, sql);

    const sessionId = randomUUID();
    const base: CompareBase = {
      question,
      metricLabel: plan.metricLabel,
      ...(cleanUnit(plan.unit) ? { unit: cleanUnit(plan.unit) } : {}),
      varying: plan.varying,
    };

    // Colour is assigned here, at fork time, and never re-derived — the whole
    // reason a culled branch leaves the survivors' colours untouched.
    const variants: CompareVariant[] = plan.variants.map((v, i) => ({
      id: randomUUID(),
      label: v.label,
      ...(v.description ? { description: v.description } : {}),
      colorSlot: i,
      sql: v.sql,
    }));

    await forkCompare({ sessionId, base, variants, baseHeadline: null });

    const sessionTag = `compare:${sessionId}`;
    const accessToken = await auth.createPublicToken({
      scopes: { read: { tags: [sessionTag] } },
      expirationTime: "1h",
    });

    return {
      ok: true,
      sessionId,
      sessionTag,
      accessToken,
      base,
      variants: variants.map((v) => ({
        id: v.id,
        label: v.label,
        ...(v.description ? { description: v.description } : {}),
        colorSlot: v.colorSlot,
      })),
    };
  } catch (cause) {
    console.error("startCompare failed", cause);
    return fail(messageOf(cause, "Could not start the comparison. Try again."));
  }
}

const AddInput = z.object({
  sessionId: z.string().min(1),
  base: Base,
  /** The base answer's SQL — every variant is derived from it. */
  sql: z.string().trim().min(1).max(8_000),
  /** The plain-language change the analyst typed, e.g. "weekends only". */
  change: z.string().trim().min(1).max(200),
  /** The palette slot this new branch owns. */
  colorSlot: z.number().int().min(0),
});

/** Add one more variant to a running session: specialise its SQL and fork it. */
export async function addCompareVariantAction(
  input: unknown,
): Promise<Ok<{ variant: VariantSeed }> | Err> {
  const parsed = AddInput.safeParse(input);
  if (!parsed.success) return fail("Invalid variant.");
  const { sessionId, base, sql, change, colorSlot } = parsed.data;

  try {
    const planned = await specializeVariant(sql, change);
    const variant: CompareVariant = {
      id: randomUUID(),
      label: planned.label || change,
      ...(planned.description ? { description: planned.description } : {}),
      colorSlot,
      sql: planned.sql,
    };

    // Same sessionId → same tag → the client's tag subscription picks it up.
    await forkCompare({ sessionId, base, variants: [variant], baseHeadline: null });

    return {
      ok: true,
      variant: {
        id: variant.id,
        label: variant.label,
        ...(variant.description ? { description: variant.description } : {}),
        colorSlot: variant.colorSlot,
      },
    };
  } catch (cause) {
    console.error("addCompareVariant failed", cause);
    return fail(messageOf(cause, "Could not add that variant. Try again."));
  }
}

const SaveInput = z.object({
  title: z.string().trim().min(1).max(120),
  branches: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        sql: z.string().trim().min(1).max(8_000),
      }),
    )
    .min(1)
    .max(8),
});

/**
 * Turn a comparison into a board: one chart tile per branch, each storing its
 * variant SQL so the board re-runs it live (the tile infers its chart shape from
 * the result, exactly like a hand-made chart tile).
 */
export async function saveCompareBoardAction(
  input: unknown,
): Promise<Ok<{ boardId: string }> | Err> {
  const parsed = SaveInput.safeParse(input);
  if (!parsed.success) return fail("Nothing to save.");
  const { title, branches } = parsed.data;

  try {
    const board = await createBoard({ title });
    for (const branch of branches) {
      await addTile({
        boardId: board.id,
        kind: "chart",
        title: branch.label,
        sql: branch.sql,
        spec: {},
      });
    }
    revalidatePath("/boards");
    revalidatePath(`/boards/${board.id}`);
    return { ok: true, boardId: board.id };
  } catch (cause) {
    console.error("saveCompareBoard failed", cause);
    return fail(messageOf(cause, "Could not build the board. Try again."));
  }
}

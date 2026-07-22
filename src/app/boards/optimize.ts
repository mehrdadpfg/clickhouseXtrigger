"use server";

import { runs, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  optimizeBoardTask,
  type OptimizeApproval,
  type OptimizeProposal,
  type OptimizeStatus,
} from "@/trigger/optimizeBoard";

/**
 * The board Optimize panel's server side.
 *
 * Same shape as Tune's actions and for the same reason: the run lives in
 * Trigger.dev, and the browser only ever holds a runId. Starting triggers the
 * task; loading reads the run's metadata (the credential that can read a run,
 * and later the token that unparks it, both stay here on the server); applying
 * completes the one waitpoint the task parks on with the tiles the reader
 * ticked. Nothing here executes SQL or writes a tile — that all happens inside
 * the task, only once the token is completed.
 */

// --- metadata parsing ------------------------------------------------------

const ProposalSchema = z.object({
  tileId: z.string(),
  title: z.string(),
  oldSql: z.string(),
  newSql: z.string(),
  changed: z.boolean(),
  mvUsed: z.string().default(""),
  note: z.string().default(""),
  status: z.enum(["proposed", "applied", "failed", "dismissed"]),
  error: z.string().optional(),
});

const OptimizeMetadataSchema = z.object({
  status: z.enum(["analyzing", "awaiting_approval", "applying", "done"]),
  boardId: z.string(),
  mvCount: z.number(),
  approvalTokenId: z.string().nullable(),
  proposals: z.array(ProposalSchema),
  summary: z.string(),
});

/** What the panel renders — the run's status and its proposed rewrites. */
export type OptimizeView = {
  runId: string;
  /** "starting" is the client-side gap before the first metadata lands. */
  status: OptimizeStatus | "starting" | "unavailable";
  mvCount: number;
  proposals: OptimizeProposal[];
  summary: string;
};

// --- starting --------------------------------------------------------------

export async function startBoardOptimizeAction(
  boardId: unknown,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const parsed = z.string().min(1).safeParse(boardId);
  if (!parsed.success) return { ok: false, error: "Not a board id." };
  try {
    const handle = await optimizeBoardTask.trigger({ boardId: parsed.data });
    return { ok: true, runId: handle.id };
  } catch (cause) {
    console.error("Could not start board optimize run", cause);
    return { ok: false, error: "Could not start the optimizer. Try again." };
  }
}

// --- polling ---------------------------------------------------------------

export async function loadBoardOptimizeAction(
  runId: unknown,
): Promise<OptimizeView | { error: string }> {
  const parsed = z.string().min(1).safeParse(runId);
  if (!parsed.success) return { error: "Not a run id." };

  let run: Awaited<ReturnType<typeof runs.retrieve>>;
  try {
    run = await runs.retrieve(parsed.data);
  } catch (cause) {
    console.error("Could not retrieve optimize run", parsed.data, cause);
    return { error: "That run is no longer available." };
  }

  const meta = OptimizeMetadataSchema.safeParse(run.metadata);
  if (!meta.success) {
    // No metadata yet (the run just started) vs. a run that failed outright.
    const failed = ["FAILED", "CRASHED", "CANCELED", "SYSTEM_FAILURE"].includes(
      run.status,
    );
    return {
      runId: parsed.data,
      status: failed ? "unavailable" : "starting",
      mvCount: 0,
      proposals: [],
      summary: "",
    };
  }

  return {
    runId: parsed.data,
    status: meta.data.status,
    mvCount: meta.data.mvCount,
    proposals: meta.data.proposals,
    summary: meta.data.summary,
  };
}

// --- applying --------------------------------------------------------------

const TileIds = z.array(z.string().min(1).max(64)).max(100);

export async function applyBoardOptimizeAction(
  runId: unknown,
  tileIds: unknown,
): Promise<{ ok: boolean; error?: string; applying?: number }> {
  const parsedRun = z.string().min(1).safeParse(runId);
  const parsedIds = TileIds.safeParse(tileIds);
  if (!parsedRun.success || !parsedIds.success) {
    return { ok: false, error: "Could not read that request." };
  }

  let run: Awaited<ReturnType<typeof runs.retrieve>>;
  try {
    run = await runs.retrieve(parsedRun.data);
  } catch {
    return { ok: false, error: "That run is no longer available." };
  }

  const meta = OptimizeMetadataSchema.safeParse(run.metadata);
  if (!meta.success) {
    return { ok: false, error: "This run has nothing to apply." };
  }
  const { approvalTokenId, proposals } = meta.data;
  if (!approvalTokenId) {
    return { ok: false, error: "This board is not waiting for approval." };
  }

  // Intersect the submitted ids with the tiles this run actually proposed to
  // change — an id the caller invented or an unchanged tile cannot get through.
  const submitted = new Set(parsedIds.data);
  const approved = proposals
    .filter((p) => p.changed && p.status === "proposed" && submitted.has(p.tileId))
    .map((p) => p.tileId);

  try {
    await wait.completeToken<OptimizeApproval>(approvalTokenId, { approved });
    return { ok: true, applying: approved.length };
  } catch (cause) {
    console.error("Could not complete optimize token", approvalTokenId, cause);
    return { ok: false, error: "Could not record your decision. Try again." };
  }
}

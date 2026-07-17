"use server";

import { runs, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  labelForQuery,
  type EvidenceView,
  type SuggestionView,
  type TuneRunStatus,
  type TuneView,
} from "@/components/tune/model";
import { analyzeQueryLog, type QueryLogAnalysis } from "@/lib/clickhouse/queryLog";
import { tuneTask, type TuneApproval } from "@/trigger/tune";

/**
 * The Optimize page's server surface.
 *
 * Three actions the page's client component calls: kick off a run, read a run's
 * state, and decide a single suggestion. Every Trigger.dev credential — the run
 * token, the waitpoint ids — stays here on the server; the browser sends only a
 * runId and an opaque suggestion id, and the approval is completed server-side.
 *
 * `loadTuneView` doubles as the page's initial-load reader (called from the
 * RSC) and the client's poll target, so both see one consistent shape.
 */

const DEFAULT_WINDOW_DAYS = 14;

// --- reading a run's metadata ----------------------------------------------

/** Only the fields the page reads. Tolerant of a run that hasn't set them yet. */
const SuggestionStateSchema = z.object({
  id: z.string(),
  tokenId: z.string(),
  kind: z.enum(["materialized_view", "projection"]),
  name: z.string(),
  targetTable: z.string(),
  title: z.string(),
  rationale: z.string(),
  questionsCovered: z.number(),
  estStorage: z.string(),
  estSpeedup: z.string(),
  statements: z.array(z.string()),
  coversHashes: z.array(z.string()).default([]),
  status: z.enum(["pending", "applied", "failed", "dismissed"]),
  error: z.string().optional(),
  decidedAt: z.string().optional(),
});

const PatternSchema = z.object({
  queryHash: z.string(),
  sampleQuery: z.string(),
  tables: z.array(z.string()),
  count: z.number(),
  avgDurationMs: z.number(),
  maxDurationMs: z.number().optional(),
  totalReadRows: z.number(),
  totalReadBytes: z.number().optional(),
  avgReadRows: z.number().optional(),
  daysActive: z.number().optional(),
});

const AnalysisSchema = z.object({
  windowDays: z.number(),
  totalQueries: z.number(),
  distinctPatterns: z.number(),
  patterns: z.array(PatternSchema),
});

const TuneMetadataSchema = z.object({
  status: z.enum(["analyzing", "proposing", "awaiting_approval", "done"]),
  windowDays: z.number(),
  finding: z.string().nullable(),
  analysis: AnalysisSchema.nullable(),
  suggestions: z.array(SuggestionStateSchema),
});

type ParsedMetadata = z.infer<typeof TuneMetadataSchema>;

/** Run states that mean "still working" — the page keeps polling while true. */
const LIVE_RUN_STATUSES = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "DELAYED",
]);

const FAILED_RUN_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "CANCELED",
  "TIMED_OUT",
  "EXPIRED",
]);

/**
 * Reconcile the run's engine status with the status the task wrote to metadata.
 * Metadata is the finer signal (it distinguishes analyzing/proposing/awaiting),
 * but a run that crashed before writing `done` must still read as failed.
 */
function deriveStatus(
  runStatus: string,
  meta: ParsedMetadata | null,
): TuneRunStatus {
  if (FAILED_RUN_STATUSES.has(runStatus)) return "failed";
  if (meta) return meta.status;
  if (LIVE_RUN_STATUSES.has(runStatus)) return "analyzing";
  return "done";
}

function toSuggestionView(
  s: ParsedMetadata["suggestions"][number],
): SuggestionView {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    targetTable: s.targetTable,
    title: s.title,
    rationale: s.rationale,
    questionsCovered: s.questionsCovered,
    estStorage: s.estStorage,
    estSpeedup: s.estSpeedup,
    // Statements joined for display; a projection reads as two lines.
    sql: s.statements.join(";\n\n") + ";",
    status: s.status,
    error: s.error,
    decidedAt: s.decidedAt,
  };
}

/**
 * The minimal analysis shape the view needs — satisfied by both a fresh
 * QueryLogAnalysis and a run's stored (zod-parsed) analysis, which carry
 * different optional extras.
 */
type EvidenceSource = {
  windowDays: number;
  totalQueries: number;
  distinctPatterns: number;
  patterns: Array<{
    queryHash: string;
    sampleQuery: string;
    count: number;
    avgDurationMs: number;
    totalReadRows: number;
    tables: string[];
  }>;
};

/** Query-log patterns → evidence rows, flagged materialized where an applied suggestion covers them. */
function toEvidence(
  analysis: EvidenceSource,
  materializedHashes: Set<string>,
): EvidenceView[] {
  return analysis.patterns.map((p) => ({
    queryHash: p.queryHash,
    label: labelForQuery(p.sampleQuery),
    sql: p.sampleQuery,
    count: p.count,
    avgDurationMs: p.avgDurationMs,
    totalReadRows: p.totalReadRows,
    tables: p.tables,
    materialized: materializedHashes.has(p.queryHash),
  }));
}

/** The empty view — no run has ever executed. Evidence still comes from the log. */
async function idleView(): Promise<TuneView> {
  let analysis: QueryLogAnalysis;
  try {
    analysis = await analyzeQueryLog({ windowDays: DEFAULT_WINDOW_DAYS });
  } catch (cause) {
    console.error("Tune query-log analysis failed", cause);
    analysis = {
      windowDays: DEFAULT_WINDOW_DAYS,
      totalQueries: 0,
      distinctPatterns: 0,
      patterns: [],
    };
  }
  return {
    runId: null,
    runStatus: "idle",
    finding: null,
    windowDays: analysis.windowDays,
    totalQueries: analysis.totalQueries,
    distinctPatterns: analysis.distinctPatterns,
    suggestions: [],
    evidence: toEvidence(analysis, new Set()),
  };
}

/** The id of the most recent tune run, or null if none has ever run. */
async function latestRunId(): Promise<string | null> {
  try {
    const page = await runs.list({
      taskIdentifier: tuneTask.id,
      period: "30d",
      limit: 1,
    });
    for await (const run of page) return run.id;
  } catch (cause) {
    console.error("Could not list tune runs", cause);
  }
  return null;
}

/**
 * Build the page view for a run — the given one, or the latest if omitted.
 *
 * Evidence is read from the run's own stored analysis (the snapshot it reasoned
 * over) rather than re-scanning system.query_log on every poll — which would
 * both cost a full scan every few seconds and pollute the very log it reads.
 * Only the run-less idle view queries the log live.
 */
export async function loadTuneView(runId?: string): Promise<TuneView> {
  const id = runId ?? (await latestRunId());
  if (!id) return idleView();

  let run: Awaited<ReturnType<typeof runs.retrieve>>;
  try {
    run = await runs.retrieve(id);
  } catch (cause) {
    console.error("Could not retrieve tune run", id, cause);
    return idleView();
  }

  const parsed = TuneMetadataSchema.safeParse(run.metadata);
  const meta = parsed.success ? parsed.data : null;
  const runStatus = deriveStatus(run.status, meta);

  const suggestions = (meta?.suggestions ?? []).map(toSuggestionView);
  const materializedHashes = new Set(
    (meta?.suggestions ?? [])
      .filter((s) => s.status === "applied")
      .flatMap((s) => s.coversHashes),
  );

  // Prefer the run's stored analysis; fall back to the log only if it has none
  // yet (the very first moment of a run, before analysis is written).
  let analysis: EvidenceSource | null = meta?.analysis ?? null;
  if (!analysis) {
    try {
      analysis = await analyzeQueryLog({
        windowDays: meta?.windowDays ?? DEFAULT_WINDOW_DAYS,
      });
    } catch {
      analysis = {
        windowDays: meta?.windowDays ?? DEFAULT_WINDOW_DAYS,
        totalQueries: 0,
        distinctPatterns: 0,
        patterns: [],
      };
    }
  }

  return {
    runId: id,
    runStatus,
    finding: meta?.finding ?? null,
    windowDays: analysis.windowDays,
    totalQueries: analysis.totalQueries,
    distinctPatterns: analysis.distinctPatterns,
    suggestions,
    evidence: toEvidence(analysis, materializedHashes),
  };
}

// --- starting a run --------------------------------------------------------

export async function startTuneAction(): Promise<
  { ok: true; runId: string } | { ok: false; error: string }
> {
  try {
    const handle = await tuneTask.trigger({});
    return { ok: true, runId: handle.id };
  } catch (cause) {
    console.error("Could not start tune run", cause);
    return { ok: false, error: "Could not start the analysis. Try again." };
  }
}

// --- approving / dismissing a suggestion -----------------------------------

const RunId = z.string().min(1);
const SuggestionId = z.string().min(1).max(40);

/**
 * Approve (or dismiss) one suggestion, unparking the run.
 *
 * The token is looked up from the run's own metadata — the browser never holds
 * it — and the suggestion must still be pending, so a token can be completed
 * once and only for a suggestion this run actually owns. The DDL itself runs
 * inside the task once the token completes; this action only unblocks it.
 */
export async function decideSuggestionAction(
  runId: unknown,
  suggestionId: unknown,
  approved: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const parsedRun = RunId.safeParse(runId);
  const parsedSuggestion = SuggestionId.safeParse(suggestionId);
  if (!parsedRun.success || !parsedSuggestion.success) {
    return { ok: false, error: "Unknown suggestion." };
  }

  let run: Awaited<ReturnType<typeof runs.retrieve>>;
  try {
    run = await runs.retrieve(parsedRun.data);
  } catch {
    return { ok: false, error: "That run is no longer available." };
  }

  const parsed = TuneMetadataSchema.safeParse(run.metadata);
  if (!parsed.success) {
    return { ok: false, error: "This run has no suggestions to decide." };
  }

  const suggestion = parsed.data.suggestions.find(
    (s) => s.id === parsedSuggestion.data,
  );
  if (!suggestion) return { ok: false, error: "Unknown suggestion." };
  if (suggestion.status !== "pending") {
    return { ok: false, error: "That suggestion has already been decided." };
  }

  try {
    await wait.completeToken<TuneApproval>(suggestion.tokenId, { approved });
    return { ok: true };
  } catch (cause) {
    console.error("Could not complete approval token", suggestion.tokenId, cause);
    return { ok: false, error: "Could not record your decision. Try again." };
  }
}

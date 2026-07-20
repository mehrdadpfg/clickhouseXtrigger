"use server";

import { runs, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  labelForQuery,
  type EvidenceView,
  type FindingView,
  type TuneRunStatus,
  type TuneView,
} from "@/components/tune/model";
import { analyzeQueryLog, type QueryLogAnalysis } from "@/lib/clickhouse/queryLog";
import { tuneTask, type TuneApproval } from "@/trigger/tune";

/**
 * The Optimize page's server surface.
 *
 * Three actions the page's client component calls: kick off a run, read a run's
 * state, and decide a single finding. Every Trigger.dev credential — the run
 * token, the waitpoint ids — stays here on the server; the browser sends only a
 * runId and an opaque finding id, and the approval is completed server-side.
 *
 * `loadTuneView` doubles as the page's initial-load reader (called from the
 * RSC) and the client's poll target, so both see one consistent shape.
 */

const DEFAULT_WINDOW_DAYS = 14;

// --- reading a run's metadata ----------------------------------------------

const KIND_VALUES = [
  "materialized_view",
  "projection",
  "skip_index",
  "column_type",
  "column_codec",
  "ttl",
  "order_by",
  "partitioning",
  "engine",
  "denormalize",
  "ingestion",
  "query_rewrite",
] as const;

/** Only the fields the page reads, tolerant of a run that hasn't set them yet. */
const FindingStateSchema = z.object({
  id: z.string(),
  kind: z.enum(KIND_VALUES),
  impact: z.enum(["CRITICAL", "HIGH", "MEDIUM"]),
  ruleId: z.string(),
  targetTable: z.string(),
  title: z.string(),
  rationale: z.string(),
  evidence: z.string(),
  estimate: z.string(),
  statements: z.array(z.string()).default([]),
  migration: z.string().default(""),
  caveat: z.string().default(""),
  status: z.enum(["pending", "applied", "failed", "dismissed", "advisory"]),
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
  retainedMinutes: z.number().default(0),
  totalQueries: z.number(),
  distinctPatterns: z.number(),
  patterns: z.array(PatternSchema),
});

const TuneMetadataSchema = z.object({
  status: z.enum([
    "analyzing",
    "investigating",
    "proposing",
    "awaiting_approval",
    "done",
  ]),
  windowDays: z.number(),
  finding: z.string().nullable(),
  analysis: AnalysisSchema.nullable(),
  profileSummary: z
    .object({ tables: z.number(), columns: z.number() })
    .nullable()
    .default(null),
  approvalTokenId: z.string().nullable().default(null),
  findings: z.array(FindingStateSchema).default([]),
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
 * Metadata is the finer signal (it distinguishes analyzing/investigating/
 * proposing/awaiting), but a run that crashed before writing `done` must still
 * read as failed.
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

function toFindingView(f: ParsedMetadata["findings"][number]): FindingView {
  return {
    id: f.id,
    kind: f.kind,
    impact: f.impact,
    ruleId: f.ruleId,
    targetTable: f.targetTable,
    title: f.title,
    rationale: f.rationale,
    evidence: f.evidence,
    estimate: f.estimate,
    // Statements joined for display; a projection reads as two lines.
    sql: f.statements.length ? `${f.statements.join(";\n\n")};` : "",
    migration: f.migration,
    caveat: f.caveat,
    status: f.status,
    error: f.error,
    decidedAt: f.decidedAt,
  };
}

/**
 * The minimal analysis shape the view needs — satisfied by both a fresh
 * QueryLogAnalysis and a run's stored (zod-parsed) analysis, which carry
 * different optional extras.
 */
type EvidenceSource = {
  windowDays: number;
  retainedMinutes?: number;
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

function toEvidence(analysis: EvidenceSource): EvidenceView[] {
  return analysis.patterns.map((p) => ({
    queryHash: p.queryHash,
    label: labelForQuery(p.sampleQuery),
    sql: p.sampleQuery,
    count: p.count,
    avgDurationMs: p.avgDurationMs,
    totalReadRows: p.totalReadRows,
    tables: p.tables,
  }));
}

const EMPTY_ANALYSIS = (windowDays: number): QueryLogAnalysis => ({
  windowDays,
  retainedMinutes: 0,
  totalQueries: 0,
  distinctPatterns: 0,
  patterns: [],
});

/** The empty view — no run has ever executed. Evidence still comes from the log. */
async function idleView(): Promise<TuneView> {
  let analysis: QueryLogAnalysis;
  try {
    analysis = await analyzeQueryLog({ windowDays: DEFAULT_WINDOW_DAYS });
  } catch (cause) {
    console.error("Tune query-log analysis failed", cause);
    analysis = EMPTY_ANALYSIS(DEFAULT_WINDOW_DAYS);
  }
  return {
    runId: null,
    runStatus: "idle",
    finding: null,
    windowDays: analysis.windowDays,
    totalQueries: analysis.totalQueries,
    distinctPatterns: analysis.distinctPatterns,
    retainedMinutes: analysis.retainedMinutes,
    tablesProfiled: 0,
    columnsProfiled: 0,
    findings: [],
    evidence: toEvidence(analysis),
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

  const findings = (meta?.findings ?? []).map(toFindingView);

  // Prefer the run's stored analysis; fall back to the log only if it has none
  // yet (the very first moment of a run, before analysis is written).
  let analysis: EvidenceSource | null = meta?.analysis ?? null;
  if (!analysis) {
    try {
      analysis = await analyzeQueryLog({
        windowDays: meta?.windowDays ?? DEFAULT_WINDOW_DAYS,
      });
    } catch {
      analysis = EMPTY_ANALYSIS(meta?.windowDays ?? DEFAULT_WINDOW_DAYS);
    }
  }

  return {
    runId: id,
    runStatus,
    finding: meta?.finding ?? null,
    windowDays: analysis.windowDays,
    totalQueries: analysis.totalQueries,
    distinctPatterns: analysis.distinctPatterns,
    retainedMinutes: analysis.retainedMinutes ?? 0,
    tablesProfiled: meta?.profileSummary?.tables ?? 0,
    columnsProfiled: meta?.profileSummary?.columns ?? 0,
    findings,
    evidence: toEvidence(analysis),
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

// --- applying the approved findings ----------------------------------------

const RunId = z.string().min(1);
const FindingIds = z.array(z.string().min(1).max(40)).max(50);

/**
 * Apply the findings the reader ticked, unparking the run.
 *
 * One call for the whole report, matching the single waitpoint the task parks
 * on — see the note in `src/trigger/tune.ts` on why it is one token and not one
 * per finding.
 *
 * The token is looked up from the run's own metadata; the browser never holds
 * it. The submitted ids are then intersected with the findings this run
 * actually has in `pending` — so an id the caller invented, an advisory
 * finding, or one already decided cannot get through, whatever was posted. The
 * DDL itself runs inside the task; this action only unblocks it.
 */
export async function applyFindingsAction(
  runId: unknown,
  findingIds: unknown,
): Promise<{ ok: boolean; error?: string; applying?: number }> {
  const parsedRun = RunId.safeParse(runId);
  const parsedIds = FindingIds.safeParse(findingIds);
  if (!parsedRun.success || !parsedIds.success) {
    return { ok: false, error: "Could not read that request." };
  }

  let run: Awaited<ReturnType<typeof runs.retrieve>>;
  try {
    run = await runs.retrieve(parsedRun.data);
  } catch {
    return { ok: false, error: "That run is no longer available." };
  }

  const parsed = TuneMetadataSchema.safeParse(run.metadata);
  if (!parsed.success) {
    return { ok: false, error: "This run has no findings to apply." };
  }

  const { approvalTokenId, findings } = parsed.data;
  if (!approvalTokenId) {
    return { ok: false, error: "This report is not waiting for approval." };
  }

  const submitted = new Set(parsedIds.data);
  const approved = findings
    .filter((f) => f.status === "pending" && submitted.has(f.id))
    .map((f) => f.id);

  try {
    await wait.completeToken<TuneApproval>(approvalTokenId, { approved });
    return { ok: true, applying: approved.length };
  } catch (cause) {
    console.error("Could not complete approval token", approvalTokenId, cause);
    return { ok: false, error: "Could not record your decision. Try again." };
  }
}

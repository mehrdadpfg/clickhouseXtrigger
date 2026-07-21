/**
 * Analyst — the orchestrated multi-agent deep-dive.
 *
 * Where tune reads the query log and the physical schema to make ClickHouse
 * faster, the analyst reads the DATA to make it more understood. A reader
 * points it at one or more tables and it dispatches a team of specialist
 * agents, each owning ONE analytical lens, then a lead synthesises their
 * findings into a single structured report: headline stats, a deduped set of
 * charts, and a ranked set of actionable recommendations.
 *
 *
 * WHY IT FANS OUT INSTEAD OF ASKING ONE AGENT EVERYTHING
 * ------------------------------------------------------
 * A single agent handed "analyse this dataset" spreads itself thin: it runs a
 * few probes across every angle and commits to none. Splitting the work by lens
 * means each specialist has one job, a full step budget for it, and a prompt
 * that only talks about that job — the trends agent buckets over time and does
 * nothing else, the structure agent reasons about storage and nothing else.
 * The lenses that fire are chosen by the DATA (triage), not fixed: a product
 * catalog earns the competitor lens, a logs table does not.
 *
 *
 * WHY THE FAN-OUT IS A BATCH, NOT Promise.all
 * -------------------------------------------
 * Trigger.dev does not support parallel waits — wrapping several
 * `triggerAndWait` calls in `Promise.all` throws. The supported parallel
 * primitive is `batchTriggerAndWait`, which triggers every specialist at once
 * and resumes this run when they have all finished, handing back a `runs` array
 * to inspect per-lens. So the fan-out is one batch call, and a specialist that
 * fails costs its lens, not the whole report.
 *
 *
 * WHY THE MODEL NEVER WRITES A NUMBER
 * -----------------------------------
 * Every chart and stat is a SPEC plus the SQL that fills it. The specialist
 * proposes the SQL; the task runs it read-only and attaches the rows. So a
 * chart cannot be hallucinated — its data is whatever ClickHouse returned — and
 * synthesis only ever SELECTS and RANKS what the specialists measured, never
 * rewriting their SQL, DDL or evidence. Recommendations' `proposedSql` is shown
 * to the reader, never executed: this task, like the reading side, is read-only.
 */
import { batch, metadata, schemaTask } from "@trigger.dev/sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { runReadonlyQuery, runReadonlyQueries } from "@/lib/clickhouse/run";
import { describeScope, renderSchema, splitId } from "@/lib/discover/discover";
import { profilePhysical, renderProfile } from "@/lib/clickhouse/diagnose";
import { LENS_IDS, lens, renderLensMenu, type LensId } from "@/lib/analyst/lenses";
import {
  SpecialistReport,
  SynthesisResult,
  TriageResult,
  type AnalystMetadata,
  type AnalystReport,
  type ChartCandidate,
  type LensRun,
  type Recommendation,
  type ReportChart,
  type ReportRecommendation,
  type ReportRow,
  type ReportStat,
  type StatCandidate,
} from "@/lib/analyst/report";

const MODEL = "claude-sonnet-5";

// --- shared helpers --------------------------------------------------------

/** The read-only SQL probe, identical in spirit to discover's queryClickhouse. */
const queryClickhouse = tool({
  description:
    "Run a read-only ClickHouse SELECT to probe the data. Aggregate — the " +
    "tables are large, never select raw rows — and add a LIMIT when sampling. " +
    "Qualify tables as db.table, no trailing semicolon, no FORMAT. Returns the rows.",
  inputSchema: z.object({
    sql: z.string().describe("One ClickHouse SELECT, qualified db.table, no trailing semicolon."),
  }),
  execute: async ({ sql }) => {
    try {
      const rows = await runReadonlyQuery(sql);
      // A probe is an aggregate, but cap regardless so one bad query can't
      // flood the agent's context.
      return { rows: rows.slice(0, 50), rowCount: rows.length };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : "Query failed." };
    }
  },
});

/** Does this value read as a number? ClickHouse returns counts as strings. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A one-row, one-column result read as a single number, or null if it isn't one. */
function scalarOf(rows: Record<string, unknown>[]): number | null {
  if (rows.length !== 1) return null;
  const values = Object.values(rows[0]!);
  if (values.length !== 1) return null;
  return asNumber(values[0]);
}

/** At most this many rows travel with a chart — a chart is an aggregate, not a dump. */
const MAX_CHART_ROWS = 200;

/**
 * Run each proposed chart's SQL and attach its rows, namespacing the id by lens
 * so two specialists can't collide. A chart whose SQL fails or returns nothing
 * is dropped — a broken chart is worse than one fewer.
 */
async function attachCharts(
  lensId: LensId,
  candidates: ChartCandidate[],
): Promise<ReportChart[]> {
  if (candidates.length === 0) return [];
  const results = await runReadonlyQueries(
    candidates.map((c) => c.sql),
    { concurrency: 3 },
  );
  const out: ReportChart[] = [];
  candidates.forEach((candidate, i) => {
    const result = results[i];
    if (!result || !result.ok || result.rows.length === 0) return;
    const { id, ...rest } = candidate;
    out.push({
      ...rest,
      id: `${lensId}.${id}`,
      lens: lensId,
      data: result.rows.slice(0, MAX_CHART_ROWS) as ReportRow[],
    });
  });
  return out;
}

/** Run each proposed stat's scalar SQL and read the number; drop the ones that don't resolve. */
async function attachStats(
  lensId: LensId,
  candidates: StatCandidate[],
): Promise<ReportStat[]> {
  if (candidates.length === 0) return [];
  const results = await runReadonlyQueries(
    candidates.map((c) => c.sql),
    { concurrency: 3 },
  );
  const out: ReportStat[] = [];
  candidates.forEach((candidate, i) => {
    const result = results[i];
    if (!result || !result.ok) return;
    const value = scalarOf(result.rows);
    if (value === null) return;
    out.push({
      id: `${lensId}.${candidate.id}`,
      lens: lensId,
      label: candidate.label,
      value,
      ...(candidate.unit ? { unit: candidate.unit } : {}),
    });
  });
  return out;
}

// --- the specialist task ---------------------------------------------------

const SpecialistPayload = z.object({
  lens: z.enum(LENS_IDS),
  tables: z.array(z.string()).min(1),
  /** The scoped tables' live schemas, rendered. Passed down rather than re-read. */
  schemaText: z.string(),
  /** The physical profile of the scoped tables, rendered. Mostly for the structure lens. */
  profileText: z.string(),
  domain: z.string(),
  focusNotes: z.string(),
});

/** What one specialist hands back to the orchestrator. */
export type SpecialistOutput = {
  lens: LensId;
  label: string;
  takeaway: string;
  charts: ReportChart[];
  stats: ReportStat[];
  recommendations: ReportRecommendation[];
};

const BASE_SPECIALIST = [
  "You are a specialist data analyst on a deep-dive team, working over a ClickHouse dataset.",
  "You own ONE analytical lens (below). Investigate ONLY through that lens — other specialists cover the rest, so don't duplicate their angles.",
  "",
  "You have a queryClickhouse tool: read-only aggregated SELECTs. USE IT — look before you assert, never guess a number, a distribution, or an overlap.",
  "Query rules: one SELECT, qualified db.table, AGGREGATE (the tables are large — never select raw rows), add a LIMIT when sampling, no DDL/DML, no trailing semicolon, no FORMAT.",
  "",
  "Investigate first: run the probes your lens calls for and establish what is actually true. Be skeptical — a claim you could not measure is one you should drop. You will be asked to write up findings afterwards.",
].join("\n");

const SPECIALIST_REPORT_PROMPT = [
  "Write up your investigation as structured findings for your lens. Rules:",
  "",
  "- `takeaway`: one sentence naming the single most important thing you found, no SQL.",
  "- CHARTS: each is a spec PLUS the `sql` that fills it — you do NOT provide the data, the",
  "  SQL is run for you. Every chart.sql is one aggregated read-only SELECT. Convention: the",
  "  chart pipeline reads columns by the `encodings` you give — map each channel to a column",
  "  ALIAS in your SELECT, e.g. {\"x\":\"month\",\"y\":\"revenue\"} for a line, {\"color\":\"cat\",\"size\":\"n\"}",
  "  for a pie, {\"x\":\"a\",\"y\":\"b\"} for a scatter. Never leave encodings empty. Pick chartType",
  "  from the shape of the result (Line/Area over time, Bar for rankings — set horizontal for long",
  "  labels, Pie/Treemap for part-to-whole, Scatter for a relationship, Histogram/Boxplot for a",
  "  distribution, Heatmap for a cross-tab).",
  "- STATS: each `sql` returns exactly ONE number (one row, one column) — a total, a rate, a",
  "  count. The value is read from running it. Label it as the metric itself ('Total revenue',",
  "  'Null rate on email').",
  "- RECOMMENDATIONS: actionable, ranked by `impact`. `evidence` is the measurement that",
  "  establishes it — no measurement, no recommendation. `proposedSql` is SHOWN to the reader,",
  "  never run: real, copyable SQL/DDL qualified db.table, one statement per array element. Leave",
  "  it empty when the recommendation isn't a schema change.",
  "- Report what you actually found. A few real findings beat a page of marginal ones, and",
  "  finding little through your lens is a legitimate result — return empty arrays rather than pad.",
].join("\n");

/**
 * Build the investigation tools. When `withWebSearch` is set (the external
 * lens), add Anthropic's web search — a provider-executed tool — so it can
 * bring in context the dataset can't hold about itself.
 */
function specialistTools(withWebSearch: boolean): ToolSet {
  return {
    queryClickhouse,
    ...(withWebSearch
      ? { webSearch: anthropic.tools.webSearch_20250305({ maxUses: 5 }) }
      : {}),
  };
}

export const analystSpecialist = schemaTask({
  id: "analyst-specialist",
  schema: SpecialistPayload,
  maxDuration: 1800,
  retry: { maxAttempts: 1 },
  // Bound how many lenses hammer ClickHouse at once. The batch queues the rest;
  // the orchestrator waits for all either way, so this is load hygiene, not a
  // behaviour change.
  queue: { concurrencyLimit: 4 },

  run: async (payload): Promise<SpecialistOutput> => {
    const spec = lens(payload.lens);
    const system = `${BASE_SPECIALIST}\n\n${spec.brief}`;

    const brief = [
      `Dataset domain (from triage): ${payload.domain}`,
      payload.focusNotes ? `\nWhat to prioritise for this dataset: ${payload.focusNotes}` : "",
      "",
      "== Table schemas ==",
      payload.schemaText,
      "",
      "== Physical profile ==",
      payload.profileText,
      "",
      "Investigate the data through your lens, then stop — you'll write up the findings next.",
    ].join("\n");

    // 1. Investigate through the lens. For `external`, web search may not be
    //    entitled on the API key; fall back to SQL-only rather than failing.
    let investigationText: string;
    try {
      const investigation = await generateText({
        model: anthropic(MODEL),
        tools: specialistTools(payload.lens === "external"),
        stopWhen: stepCountIs(16),
        maxOutputTokens: 6000,
        system,
        prompt: brief,
      });
      investigationText = investigation.text;
    } catch (cause) {
      if (payload.lens !== "external") throw cause;
      // Retry the external lens without web search — its framing then rests on
      // the data alone, which is still a valid (if thinner) exploratory pass.
      const investigation = await generateText({
        model: anthropic(MODEL),
        tools: specialistTools(false),
        stopWhen: stepCountIs(12),
        maxOutputTokens: 6000,
        system,
        prompt: brief,
      });
      investigationText = investigation.text;
    }

    // 2. Structure the findings. A separate call, like tune: forcing a schema
    //    onto the tool loop makes the model economise on investigation.
    const { object } = await generateObject({
      model: anthropic(MODEL),
      schema: SpecialistReport,
      maxOutputTokens: 8000,
      system,
      prompt: [
        brief,
        "",
        "== Your investigation ==",
        investigationText,
        "",
        SPECIALIST_REPORT_PROMPT,
      ].join("\n"),
    });

    // 3. Run the proposed SQL to fill charts and stats — the model authored the
    //    SQL, ClickHouse authors the numbers.
    const [charts, stats] = await Promise.all([
      attachCharts(payload.lens, object.charts),
      attachStats(payload.lens, object.stats),
    ]);

    // An exploratory lens can't launder a speculative finding as hard data:
    // force the flag and the category server-side, whatever the model set.
    const recommendations: ReportRecommendation[] = object.recommendations.map(
      (rec: Recommendation) => ({
        ...rec,
        id: `${payload.lens}.${rec.id}`,
        lens: payload.lens,
        ...(spec.exploratory
          ? { exploratory: true, category: "external" as const }
          : {}),
      }),
    );

    return {
      lens: payload.lens,
      label: spec.label,
      takeaway: object.takeaway,
      charts,
      stats,
      recommendations,
    };
  },
});

// --- triage ----------------------------------------------------------------

const TRIAGE_SYSTEM = [
  "You are the lead of a data deep-dive team, triaging a ClickHouse dataset before dispatching specialists.",
  "You are given the live schemas and the physical profile of the scoped tables.",
  "",
  "Do two things:",
  "1. CLASSIFY the domain in a few words, from the table and column names, types and comments — e.g. 'E-commerce product catalog', 'Application request logs', 'Ride-hail trips'.",
  "2. CHOOSE which lenses to dispatch. Pick the subset that FITS this data — not all of them. The menu:",
  "",
  "{{LENS_MENU}}",
  "",
  "Guidance:",
  "- structure and quality are almost always worth running.",
  "- trends needs a usable date/time column — only pick it if one exists.",
  "- segments needs categorical dimensions worth breaking down by.",
  "- enrichment fits when there are multiple tables, or a lone table clearly references a dimension it doesn't hold.",
  "- external is EXPLORATORY: pick it ONLY when the domain warrants outside context (a product catalog, a public company, a market/geography). Do NOT pick it for internal telemetry, logs, or infrastructure data.",
  "",
  "In `focusNotes`, tell the specialists what matters most for THIS dataset in a sentence or two — it is handed to all of them.",
].join("\n");

// --- synthesis -------------------------------------------------------------

const SYNTHESIS_SYSTEM = [
  "You are the lead analyst assembling a deep-dive report from your specialists' findings.",
  "Your job is to CURATE, not to invent: select and RANK the strongest findings from the ids below, dedupe overlap between lenses, and write the overview. Never invent a finding, a number, or an id that isn't listed.",
  "",
  "- `overview`: 2–4 short markdown paragraphs. Lead with what the data is and the single most important thing across all lenses, then the supporting findings. Name real numbers from the stats/charts. Call out any exploratory (external) findings AS exploratory so they don't read as hard data. No SQL.",
  "- `chartIds`: the charts worth showing, best first, deduped — drop redundant or weak ones. Prefer a tight set over everything.",
  "- `statIds`: the headline KPIs, most important first.",
  "- `recommendationIds`: the recommendations, ranked most actionable and impactful first, deduped across lenses.",
  "Use the ids exactly as given.",
].join("\n");

function renderCatalog(charts: ReportChart[], stats: ReportStat[], recs: ReportRecommendation[]): string {
  const chartLines = charts.length
    ? charts
        .map(
          (c) =>
            `- ${c.id} [${c.chartType}] "${c.title}" — ${c.caption || "(no caption)"} ` +
            `(lens ${c.lens}, ${c.data.length} rows)`,
        )
        .join("\n")
    : "(none)";
  const statLines = stats.length
    ? stats
        .map((s) => `- ${s.id} "${s.label}" = ${s.value}${s.unit ?? ""} (lens ${s.lens})`)
        .join("\n")
    : "(none)";
  const recLines = recs.length
    ? recs
        .map(
          (r) =>
            `- ${r.id} [${r.category}/${r.impact}${r.exploratory ? "/exploratory" : ""}] ` +
            `${r.title} — ${r.evidence || r.rationale.slice(0, 120)} (lens ${r.lens})`,
        )
        .join("\n")
    : "(none)";
  return [
    "== Candidate charts ==",
    chartLines,
    "",
    "== Candidate stats ==",
    statLines,
    "",
    "== Candidate recommendations ==",
    recLines,
  ].join("\n");
}

// --- the orchestrator task -------------------------------------------------

const AnalystPayload = z.object({
  /** One or more "database.table" ids. One table is a valid deep-dive. */
  tables: z.array(z.string().min(1)).min(1).max(6),
  /** Optional plain-language nudge for what to dig into first. */
  focus: z.string().max(400).optional(),
});

/** Caps on the final report, in case synthesis over-selects. */
const MAX_REPORT_CHARTS = 8;
const MAX_REPORT_STATS = 6;
const MAX_REPORT_RECS = 10;

/** Select by id, preserving the given order and dropping unknown/duplicate ids. */
function pick<T extends { id: string }>(pool: Map<string, T>, ids: string[], max: number): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const item = pool.get(id);
    if (item) {
      out.push(item);
      seen.add(id);
    }
    if (out.length >= max) break;
  }
  return out;
}

export const analystOrchestrator = schemaTask({
  id: "analyst-orchestrator",
  schema: AnalystPayload,
  maxDuration: 3600,
  retry: { maxAttempts: 1 },

  run: async (payload): Promise<AnalystReport> => {
    const initial: AnalystMetadata = {
      status: "triaging",
      tables: payload.tables,
      domain: null,
      lenses: [],
      report: null,
      error: null,
    };
    metadata.replace(initial);

    // 1. Profile: live schemas + the physical shape of the scoped tables.
    const schemas = await describeScope(payload.tables);
    if (schemas.length === 0) {
      metadata.set("status", "failed").set("error", "None of the tables could be described.");
      throw new Error("None of the requested tables could be described.");
    }
    const schemaText = schemas.map(renderSchema).join("\n\n");

    const scoped = new Set(payload.tables.map((t) => {
      const { database, name } = splitId(t);
      return `${database}.${name}`;
    }));
    const physical = await profilePhysical();
    const filtered = {
      ...physical,
      tables: physical.tables.filter((t) => scoped.has(`${t.database}.${t.name}`)),
    };
    const profileText = filtered.tables.length
      ? renderProfile(filtered)
      : "(no MergeTree storage profile available for these tables)";

    // Any date/time column? Gates the trends lens deterministically. Read off
    // the column types (robust to Nullable(DateTime), DateTime64, …) rather than
    // the rendered text.
    const timePresent = schemas.some((s) =>
      s.columns.some((c) => /date|time/i.test(c.type)),
    );

    // 2. Triage: classify the domain and choose the lenses that fit this data.
    const focusLine = payload.focus
      ? `\n\nThe reader is especially interested in: "${payload.focus}". Let it tilt your choices.`
      : "";
    const triageBrief = [
      `Scoped tables: ${payload.tables.join(", ")}`,
      timePresent
        ? "Signal: at least one date/time column is present."
        : "Signal: NO date/time column detected — trends is unlikely to apply.",
      schemas.length > 1
        ? `Signal: ${schemas.length} tables in scope — enrichment/joins may apply.`
        : "Signal: a single table in scope.",
      focusLine,
      "",
      "== Table schemas ==",
      schemaText,
      "",
      "== Physical profile ==",
      profileText,
    ].join("\n");

    const { object: triage } = await generateObject({
      model: anthropic(MODEL),
      schema: TriageResult,
      maxOutputTokens: 2000,
      system: TRIAGE_SYSTEM.replace("{{LENS_MENU}}", renderLensMenu()),
      prompt: triageBrief,
    });

    // Dedupe, and enforce the one hard gate (no time column ⇒ no trends). Fall
    // back to a sensible default set if triage somehow returned nothing usable.
    let lensIds = [...new Set(triage.lenses)];
    if (!timePresent) lensIds = lensIds.filter((l) => l !== "trends");
    if (lensIds.length === 0) lensIds = ["structure", "quality"];

    metadata
      .set("domain", triage.domain)
      .set("lenses", lensIds)
      .set("status", "investigating");

    // 3. Fan out to the specialists — one batch, NOT parallel waits.
    const results = await analystSpecialist.batchTriggerAndWait(
      lensIds.map((lensId) => ({
        payload: {
          lens: lensId,
          tables: payload.tables,
          schemaText,
          profileText,
          domain: triage.domain,
          focusNotes: triage.focusNotes,
        },
      })),
    );

    // Collect what succeeded; a failed lens is logged into the report's lens
    // list by its absence, not by blanking the run.
    const outputs: SpecialistOutput[] = [];
    for (const run of results.runs) {
      if (run.ok) outputs.push(run.output);
    }
    if (outputs.length === 0) {
      metadata.set("status", "failed").set("error", "Every specialist lens failed.");
      throw new Error("Every specialist lens failed to produce findings.");
    }

    // 4. Pool the findings, keyed by their namespaced ids.
    const chartPool = new Map<string, ReportChart>();
    const statPool = new Map<string, ReportStat>();
    const recPool = new Map<string, ReportRecommendation>();
    const lensRuns: LensRun[] = [];
    for (const out of outputs) {
      lensRuns.push({ id: out.lens, label: out.label, takeaway: out.takeaway });
      for (const c of out.charts) chartPool.set(c.id, c);
      for (const s of out.stats) statPool.set(s.id, s);
      for (const r of out.recommendations) recPool.set(r.id, r);
    }

    // 5. Synthesis: the lead curates and ranks, and writes the overview. It only
    //    selects from the pooled ids — it never authors a number or a SQL.
    metadata.set("status", "synthesizing");
    const allCharts = [...chartPool.values()];
    const allStats = [...statPool.values()];
    const allRecs = [...recPool.values()];

    const { object: synthesis } = await generateObject({
      model: anthropic(MODEL),
      schema: SynthesisResult,
      maxOutputTokens: 4000,
      system: SYNTHESIS_SYSTEM,
      prompt: [
        `Dataset domain: ${triage.domain}. Tables: ${payload.tables.join(", ")}.`,
        `Lenses that ran: ${lensRuns.map((l) => `${l.label} — ${l.takeaway}`).join(" | ")}`,
        "",
        renderCatalog(allCharts, allStats, allRecs),
        "",
        "Select, rank, dedupe, and write the overview.",
      ].join("\n"),
    });

    // 6. Assemble. Selection wins; if synthesis picked nothing for a band, fall
    //    back to the pool so the report is never emptier than the findings were.
    const charts = synthesis.chartIds.length
      ? pick(chartPool, synthesis.chartIds, MAX_REPORT_CHARTS)
      : allCharts.slice(0, MAX_REPORT_CHARTS);
    const stats = synthesis.statIds.length
      ? pick(statPool, synthesis.statIds, MAX_REPORT_STATS)
      : allStats.slice(0, MAX_REPORT_STATS);
    const recommendations = synthesis.recommendationIds.length
      ? pick(recPool, synthesis.recommendationIds, MAX_REPORT_RECS)
      : allRecs.slice(0, MAX_REPORT_RECS);

    const report: AnalystReport = {
      version: 1,
      tables: payload.tables,
      domain: triage.domain,
      lenses: lensRuns,
      overview: synthesis.overview,
      stats,
      charts,
      recommendations,
    };

    metadata.set("report", report).set("status", "done");
    return report;
  },
});

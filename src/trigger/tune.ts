/**
 * Tune — the read → act shift.
 *
 * The chat agent reads. Watchers keep reading on a schedule. Tune is the first
 * feature that *changes* ClickHouse: it reads the query log and the physical
 * shape of the tables, works out what is costing the reader, and — only once a
 * human says yes — applies the change.
 *
 *
 * WHY IT INVESTIGATES RATHER THAN ANSWERS IN ONE SHOT
 * ---------------------------------------------------
 * An earlier version was a single generateObject call: evidence in, suggestions
 * out. That structurally limited it to conclusions reachable from the query log
 * alone, which is exactly two — a materialized view and a projection. Real
 * ClickHouse problems (a sort key that leads with the wrong column, a String
 * holding numbers, small writes outrunning merges) are invisible there.
 *
 * So the run now has two phases. First it *investigates*: it is handed the
 * query log, the physical profile and the rulebook, and given read-only tools to
 * chase what it notices. Then it reports what it found. The investigation phase
 * is what makes the difference between "this column compresses 9x so it is
 * probably repetitive" and "this column has 427 distinct values" — the first is
 * a guess, the second decides.
 *
 *
 * WHY MOST FINDINGS HAVE NO BUTTON
 * ---------------------------------
 * ClickHouse cannot change a sort key in place. Verified against 26.2.1:
 * reordering an existing ORDER BY is rejected outright, and appending is
 * permitted only for columns added in the same statement — so it cannot fix an
 * existing key either. The same is true of PARTITION BY and the engine.
 *
 * Pretending otherwise would be the worst thing this feature could do, so
 * `rules.ts` splits every optimization kind into appliable and advisory, and
 * `isAppliable` is enforced here at execution time, not merely described in the
 * prompt. An advisory finding has its statements stripped server-side before it
 * is ever stored, and the executor only ever iterates findings that are pending
 * — so there is no code path that could run one, however it was proposed.
 *
 *
 * WHY ONE WAIT TOKEN FOR THE WHOLE REPORT
 * ---------------------------------------
 * The DDL that IS appliable is real and mutating. That must never happen
 * because a model proposed it — only because a person approved it. So the run
 * does not decide. It proposes, publishes to run metadata (which the Tune page
 * renders), and parks on a single waitpoint token. It stays parked — costing
 * nothing, holding no connection — until someone completes that token from the
 * UI with the set of findings they approved.
 *
 * One token for the batch, not one per finding, for two reasons. The first is a
 * hard platform constraint: Trigger.dev does not support parallel waits, so
 * `Promise.all` around several `wait.forToken` calls throws outright, and
 * awaiting them in sequence would mean approving the third finding does nothing
 * until the first two are also decided (or time out 24 hours later).
 *
 * The second is that it is simply the better shape for a report. You read the
 * whole thing, tick what you want, and apply once — rather than being asked to
 * commit to each finding in isolation before you have seen the rest.
 *
 * The token never reaches the browser. The page sends finding ids through a
 * server action, which looks the token up in this run's metadata and completes
 * it server-side, so the credential that can mutate the cluster stays on the
 * server.
 */
import { metadata, schemaTask, wait } from "@trigger.dev/sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { clickhouse, READONLY_SETTINGS } from "@/lib/clickhouse/client";
import { analyzeQueryLog, type QueryLogAnalysis } from "@/lib/clickhouse/queryLog";
import {
  checkConversion,
  parseColumnModifications,
  profilePhysical,
  renderProfile,
  sampleCardinality,
  type PhysicalProfile,
} from "@/lib/clickhouse/diagnose";
import {
  isAppliable,
  kindSpec,
  renderRulebook,
  type Impact,
  type OptimizationKind,
} from "@/lib/clickhouse/rules";

// --- shapes shared with the reading side ----------------------------------

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
] as const satisfies readonly OptimizationKind[];

/**
 * A finding, as the model reports it.
 *
 * Constraints are kept loose on purpose: generateObject rejects the whole
 * response if any field trips a bound, so length caps on model-authored prose
 * turn into "response did not match schema" failures. Types are pinned; sizes
 * are advised in the prompt, not enforced.
 */
const ProposedFinding = z.object({
  kind: z.enum(KIND_VALUES),
  impact: z.enum(["CRITICAL", "HIGH", "MEDIUM"]),
  /** The rulebook id this cites, e.g. `schema-types-lowcardinality`. */
  ruleId: z.string(),
  /** The table it concerns, as `database.table`. */
  targetTable: z.string(),
  /** A short human title for the card. */
  title: z.string(),
  /** Why this is a problem here, in one or two lines. */
  rationale: z.string(),
  /**
   * The measurement that establishes it — a distinct count, a ratio, a part
   * count. What separates a finding from a guess, so it is required.
   */
  evidence: z.string(),
  /** Expected effect, phrased tersely for a chip. */
  estimate: z.string(),
  /** DDL, one statement per element. Appliable kinds only; stripped otherwise. */
  statements: z.array(z.string()).default([]),
  /** For advisory kinds: what the reader would have to do instead. */
  migration: z.string().default(""),
  /** Anything the reader should know before approving (e.g. a long rebuild). */
  caveat: z.string().default(""),
});

const FindingsResult = z.object({
  /** Two or three sentences summarising the state of the schema, no SQL. */
  finding: z.string(),
  findings: z.array(ProposedFinding),
});

export type FindingStatus =
  | "pending"
  | "applied"
  | "failed"
  | "dismissed"
  /** Advisory findings are terminal on arrival — there is nothing to approve. */
  | "advisory";

/**
 * The life of an MV backfill, tracked separately from the finding's own status.
 *
 * A materialized_view finding can be `applied` (the view exists) while its
 * backfill is still `running`, or `failed`, or was never asked for — so the two
 * cannot share one field. `skipped` is the "we could not build a safe INSERT
 * from this DDL" outcome: the view is fine, we just declined to guess at how to
 * populate it. Undefined means no backfill was ever requested for this finding.
 */
export type BackfillStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export type FindingState = z.infer<typeof ProposedFinding> & {
  id: string;
  status: FindingStatus;
  error?: string;
  decidedAt?: string;
  /** Set only on materialized_view findings the reader chose to backfill. */
  backfillStatus?: BackfillStatus;
  backfillError?: string;
};

export type TuneStatus =
  | "analyzing"
  | "investigating"
  | "proposing"
  | "awaiting_approval"
  | "done";

export type TuneMetadata = {
  status: TuneStatus;
  windowDays: number;
  finding: string | null;
  analysis: QueryLogAnalysis | null;
  /** Table/column counts for the header. The full profile is too big for metadata. */
  profileSummary: { tables: number; columns: number } | null;
  /**
   * The one token gating this report's DDL. Server-only — the page never sees
   * it; it sends finding ids and the server action resolves the token.
   */
  approvalTokenId: string | null;
  findings: FindingState[];
};

/**
 * The reader's decision, carried in the token completion.
 *
 * `approved` is which findings, by id, they ticked. `backfill` is the subset of
 * approved materialized_view findings they also asked us to populate after
 * creating — an MV only captures NEW inserts, so on a static dataset its target
 * stays empty until the existing rows are replayed through it. It rides along in
 * this same payload rather than needing its own token: the whole report is still
 * gated by one waitpoint (see the header note), the backfill choices are just
 * more of the one decision.
 */
export type TuneApproval = { approved: string[]; backfill?: string[] };

// --- DDL guard -------------------------------------------------------------

/**
 * Kinds Tune refuses to apply, whatever the rulebook's `applies` says.
 *
 * `column_type` is `applies: "mutation"` in `rules.ts` — on paper an in-place
 * ALTER … MODIFY COLUMN … <type>, so historically it got an Approve button. In
 * practice that ALTER schedules a background mutation that rewrites the whole
 * column, and on a 3.1B-row table it saturates the cluster and errors with "too
 * many alters concurrently". So we demote it to advisory *here*, at the one
 * place that turns a kind into a button, without touching the shared rulebook:
 * a column_type finding is still reported (a String holding numbers is worth a
 * human's eyes), but it carries a migration note, never executable DDL.
 *
 * NOTE: `column_codec` (MODIFY COLUMN … CODEC) triggers the SAME part-rewrite
 * mutation with the same risk. It is deliberately left appliable for now — the
 * ask was column *type* only — but if the cluster keeps hitting mutation
 * limits, this set is where its second demotion would go.
 */
const DISABLED_KINDS: ReadonlySet<OptimizationKind> = new Set(["column_type"]);

/**
 * Whether Tune will actually turn a finding of this kind into DDL it runs.
 *
 * The rulebook's `isAppliable` is necessary but no longer sufficient: a kind
 * has to be appliable AND not one we have pulled back to advisory. Everything
 * downstream — the strip in step 4, the guard in `assertAllowedDdl` — goes
 * through here so the two claims cannot drift apart.
 */
function tuneCanApply(kind: OptimizationKind): boolean {
  return isAppliable(kind) && !DISABLED_KINDS.has(kind);
}

/**
 * The statement shapes each appliable kind is allowed to produce.
 *
 * Per-kind rather than one blanket allowlist: a `projection` finding must not
 * be able to smuggle in a CREATE MATERIALIZED VIEW, and vice versa. The kind is
 * chosen by the model, but it is also what the card *told the reader they were
 * approving* — so the statement has to match it.
 *
 * `column_type` is intentionally absent: it is a DISABLED_KIND (see above), so
 * it can never reach a point where it needs a shape — and if it somehow did,
 * the missing entry makes `assertAllowedDdl` refuse it rather than run a column
 * rewrite.
 */
const ALLOWED_SHAPE: Partial<Record<OptimizationKind, RegExp>> = {
  // A real MV is two statements: its backing target table, then the view TO it
  // (ClickHouse best practice — an inline-storage MV can't be resized or read on
  // its own). So this kind legitimately carries a CREATE TABLE alongside the
  // CREATE MATERIALIZED VIEW; allow both. CREATE TABLE is non-destructive and the
  // destructive-verb guard below still blocks DROP / TRUNCATE / RENAME etc.
  materialized_view: /^create\s+(or\s+replace\s+)?(materialized\s+view|table|view)\b/i,
  projection: /^alter\s+table\s+[\w.`"]+\s+(add|materialize|drop)\s+projection\b/i,
  skip_index: /^alter\s+table\s+[\w.`"]+\s+(add|materialize|drop)\s+index\b/i,
  column_codec: /^alter\s+table\s+[\w.`"]+\s+modify\s+column\b/i,
  ttl: /^alter\s+table\s+[\w.`"]+\s+(modify|remove)\s+ttl\b/i,
};

/**
 * The last line of defence before a statement runs against the cluster.
 *
 * Approval already gates every statement; this is belt-and-braces on top. A
 * statement must match the shape its own kind declares, be a single statement,
 * and contain none of the destructive verbs — however it got proposed.
 */
export function assertAllowedDdl(
  kind: OptimizationKind,
  statement: string,
): void {
  if (!tuneCanApply(kind)) {
    // Unreachable via the normal path — statements are stripped from advisory
    // findings (and from demoted kinds like column_type) long before here. Kept
    // because "unreachable" and "safe" are different claims, and this one is
    // cheap.
    throw new Error(`Refusing DDL for advisory finding kind "${kind}".`);
  }

  const s = statement
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");

  if (s.includes(";")) {
    throw new Error("Refusing DDL with more than one statement.");
  }

  const shape = ALLOWED_SHAPE[kind];
  if (!shape || !shape.test(s)) {
    throw new Error(
      `Refusing DDL that does not match a ${kind} statement: "${s.slice(0, 90)}…"`,
    );
  }

  if (
    /\b(drop\s+(table|database|dictionary|view)|truncate|delete\s+from|insert\s+into|attach|detach|rename|grant|revoke|optimize\s+table)\b/i.test(
      s,
    )
  ) {
    throw new Error("Refusing DDL containing a destructive statement.");
  }
}

/**
 * Refuse a type change that would not survive contact with the real column.
 *
 * The second half of the guard, and the more important one. `assertAllowedDdl`
 * checks the statement's *shape*; this checks its *effect*, which for a type
 * change cannot be read off the SQL at all.
 *
 * It exists because ClickHouse fails this case in the worst possible way,
 * verified on 26.2.1: the ALTER returns success, the rewrite runs later as a
 * background mutation, and one unparseable value makes that mutation stick and
 * the table unreadable — a plain SELECT then throws. `clickhouse.command()`
 * returning cleanly is therefore not evidence the change was safe, so without
 * this the task would report "Applied" on a change that bricked a table.
 *
 * The investigation phase samples, and a sample is exactly what misses the
 * 8,000 non-numeric rows at the far end of a column. So this re-checks every
 * proposed conversion against the whole column, immediately before running it.
 */
async function assertConversionsAreSafe(
  targetTable: string,
  statement: string,
): Promise<void> {
  const mods = parseColumnModifications(statement);
  if (mods.length === 0) return;

  const dot = targetTable.indexOf(".");
  if (dot < 0) throw new Error(`Cannot verify conversions on "${targetTable}".`);
  const database = targetTable.slice(0, dot);
  const table = targetTable.slice(dot + 1);

  const checks = await Promise.all(
    mods.map((m) => checkConversion(database, table, m.column, m.targetType)),
  );

  const unsafe = checks.filter((c) => !c.safe);
  if (unsafe.length === 0) return;

  throw new Error(
    `Refused — would corrupt the table. ${unsafe
      .map((c) => {
        const examples = c.examples.length
          ? ` (e.g. ${c.examples.map((e) => `"${e}"`).join(", ")})`
          : "";
        return `${c.column} → ${c.targetType}: ${c.reason}${examples}`;
      })
      .join(" ")}`,
  );
}

// --- MV backfill -----------------------------------------------------------

/**
 * Pull the target table and the SELECT body back out of a CREATE MATERIALIZED
 * VIEW … TO … AS SELECT … statement, so we can replay the existing rows.
 *
 * An MV only ever sees rows inserted *after* it exists. On a static dataset —
 * which is exactly what Tune is pointed at — that means its target table is
 * empty until we run the view's own SELECT over the source table once and write
 * the result in. The one thing we must get right is the target: an INSERT aimed
 * at the wrong table would write real rows to the wrong place, so if the shape
 * is at all ambiguous we return null and skip rather than guess.
 *
 * Best-effort by nature — it is parsing SQL with a regex — but it only has to
 * cope with the DDL this task itself proposed, which is a plain `TO <target> AS
 * SELECT …`. `.+?` between the view name and `TO` tolerates an `ON CLUSTER`
 * clause; anything it cannot read cleanly falls through to null.
 */
function parseMaterializedView(
  statement: string,
): { target: string; select: string } | null {
  const s = statement
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");

  const m =
    /^create\s+materialized\s+view\s+.+?\s+to\s+([\w.`"]+)\s+as\s+([\s\S]+)$/i.exec(
      s,
    );
  const target = m?.[1];
  const select = m?.[2]?.trim();
  if (!target || !select) return null;

  // The body has to actually be a query — never anything that could mutate.
  if (!/^(select|with)\b/i.test(select)) return null;

  return { target, select };
}

/**
 * Guard the backfill statement the same way `assertAllowedDdl` guards the rest.
 *
 * A backfill is the one place Tune writes *rows* rather than schema, so it gets
 * its own last-line check: it must be a single INSERT INTO … SELECT (INSERT
 * INTO is on the destructive-verb list for every other kind, so it needs its
 * own allowlist here) and must carry none of the genuinely destructive verbs.
 */
function assertBackfillInsert(statement: string): void {
  const s = statement
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");

  if (s.includes(";")) {
    throw new Error("Refusing a backfill with more than one statement.");
  }
  if (!/^insert\s+into\s+[\w.`"]+\s+(select|with)\b/i.test(s)) {
    throw new Error("Refusing a backfill that is not a single INSERT … SELECT.");
  }
  if (
    /\b(drop\s+(table|database|dictionary|view)|truncate|delete\s+from|alter\s+table|attach|detach|rename|grant|revoke|optimize\s+table)\b/i.test(
      s,
    )
  ) {
    throw new Error("Refusing a backfill containing a destructive statement.");
  }
}

/**
 * Populate a just-created MV's target by replaying the source through its SELECT.
 *
 * Called only after the finding's CREATE statements have all succeeded, and
 * only for findings the reader ticked for backfill. It owns its own status
 * field and, deliberately, never throws: the view itself was created fine, so a
 * backfill that cannot be parsed or that fails to run must not flip the finding
 * to `failed` — it records the outcome on `backfillStatus` and returns. Each
 * transition is flushed to metadata so the page can show "backfilling…" while
 * the INSERT … SELECT — which over a large source table is heavy — is in flight.
 */
async function backfillMaterializedView(
  state: FindingState,
  states: FindingState[],
): Promise<void> {
  // An MV finding carries a CREATE TABLE for its target alongside the view;
  // it is the CREATE MATERIALIZED VIEW we replay through, not the table.
  const createMv = state.statements.find((stmt) =>
    /^\s*create\s+materialized\s+view\b/i.test(stmt),
  );
  const parsed = createMv ? parseMaterializedView(createMv) : null;

  if (!parsed) {
    // Could not read the target and SELECT back out of the DDL. The view is
    // fine; we just decline to guess an INSERT target and leave it to the
    // reader to backfill by hand.
    state.backfillStatus = "skipped";
    state.backfillError =
      "Could not parse the view's target table and SELECT to build a backfill.";
    metadata.set("findings", states);
    return;
  }

  const insert = `INSERT INTO ${parsed.target} ${parsed.select}`;

  state.backfillStatus = "running";
  metadata.set("findings", states);

  try {
    assertBackfillInsert(insert);
    // Heavy: a full replay of the source table. Sequential with everything else
    // in the apply loop, one at a time, which is the correct load on the cluster.
    await clickhouse.command({ query: insert });
    state.backfillStatus = "done";
  } catch (cause) {
    state.backfillStatus = "failed";
    state.backfillError =
      cause instanceof Error ? cause.message : "Backfill failed.";
  }
  metadata.set("findings", states);
}

// --- the investigation tools ----------------------------------------------

/**
 * Read-only SQL, for the agent to check a hunch the profile only hints at.
 *
 * Bounded by READONLY_SETTINGS (readonly=2, a row cap and a time cap), which is
 * the same bound the chat agent's queries run under. It is a genuinely useful
 * escape hatch — min/max to size a numeric type, a countIf to see whether a
 * Nullable column ever actually holds NULL — and it is why the findings carry
 * measurements rather than adjectives.
 */
const diagnosticTools = {
  measureCardinality: tool({
    description:
      "Count distinct values in specific columns of one table. Use this before " +
      "proposing LowCardinality or Enum — a high compression ratio only suggests " +
      "repetition, this decides it. LowCardinality is right below ~10,000 distinct " +
      "values and actively harmful above it.",
    inputSchema: z.object({
      database: z.string(),
      table: z.string(),
      columns: z.array(z.string()).min(1).max(12),
    }),
    // Errors are returned, not thrown: a single column that will not sample
    // (an unsupported type, a table too wide to read inside the time cap) must
    // cost the agent that one measurement, not the whole investigation.
    execute: async ({ database, table, columns }) => {
      try {
        return { samples: await sampleCardinality(database, table, columns) };
      } catch (cause) {
        return {
          error: cause instanceof Error ? cause.message : "Sampling failed.",
        };
      }
    },
  }),

  checkConversion: tool({
    description:
      "Check whether changing one column to a new type is safe, across the WHOLE " +
      "column — not a sample. Call this before proposing ANY type change. A " +
      "sampled column that looks numeric can still hold thousands of values that " +
      "are not, and an unparseable value does not merely fail: it makes the " +
      "table unreadable. Also catches identifiers like '007' that parse but lose " +
      "their leading zeros.",
    inputSchema: z.object({
      database: z.string(),
      table: z.string(),
      column: z.string(),
      targetType: z
        .string()
        .describe("The proposed type, e.g. UInt32, DateTime, LowCardinality(String)."),
    }),
    execute: async ({ database, table, column, targetType }) => {
      try {
        return await checkConversion(database, table, column, targetType);
      } catch (cause) {
        return {
          error: cause instanceof Error ? cause.message : "Check failed.",
        };
      }
    },
  }),

  runDiagnostic: tool({
    description:
      "Run one read-only SELECT to check something the profile only hints at — " +
      "min/max to size a numeric type, countIf(isNull(x)) to see whether a Nullable " +
      "column is ever null, a value sample to see whether a String is really a number. " +
      "Always add a LIMIT. Cannot write.",
    inputSchema: z.object({
      sql: z.string().describe("A single SELECT. No DDL, no INSERT."),
      purpose: z.string().describe("What you are checking, in a few words."),
    }),
    execute: async ({ sql }) => {
      if (!/^\s*(select|with)\b/i.test(sql) || /;/.test(sql.trim().replace(/;\s*$/, ""))) {
        return { error: "Only a single SELECT/WITH statement is allowed." };
      }
      try {
        const result = await clickhouse.query({
          query: sql,
          format: "JSONEachRow",
          clickhouse_settings: READONLY_SETTINGS,
        });
        return { rows: await result.json() };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Query failed." };
      }
    },
  }),
};

// --- prompts ---------------------------------------------------------------

const INVESTIGATE_PROMPT = [
  "You are a ClickHouse performance engineer reviewing a live database.",
  "",
  "You are given: the recurring SELECT patterns from the query log, the physical",
  "profile of every table (sort key, partition key, part counts, per-column type",
  "and compression ratio), and a rulebook of ClickHouse best practices.",
  "",
  "Your job in this phase is to INVESTIGATE, not to conclude. Work through the",
  "rulebook against the evidence and use the tools to turn suspicions into",
  "measurements. Specifically:",
  "",
  "- A String column with a high compression ratio MIGHT want LowCardinality.",
  "  Call measureCardinality before believing it. Above ~10,000 distinct values",
  "  LowCardinality makes things worse, so this check decides the answer.",
  "- A String column whose values look numeric, date-like, or like an IP or UUID",
  "  is a native-type problem, not a cardinality one. Sample the values.",
  "- Before narrowing a numeric type, check its real min/max.",
  "- Before removing Nullable, check whether it ever actually holds NULL.",
  "- Judge the sort key against what the query log actually filters on, not",
  "  against what looks tidy.",
  "- A high part count against a modest row count means small writes.",
  "",
  "Do not propose anything yet. Investigate the things that look wrong, then",
  "summarise what you established and what you measured. Be skeptical: a finding",
  "you could not measure is a finding you should drop.",
].join("\n");

const REPORT_PROMPT = [
  "You are a ClickHouse performance engineer writing up a review you just did.",
  "",
  "Turn your investigation into findings. Rules:",
  "",
  "- Every finding cites a `ruleId` from the rulebook and carries `evidence`:",
  "  the measurement that establishes it. No measurement, no finding.",
  "- `kind` decides whether a finding can be applied. Read the rulebook's split",
  "  carefully. APPLIABLE kinds get real, executable ClickHouse DDL in",
  "  `statements`, written against the live schema — never invent a column, and",
  "  qualify every object as db.name.",
  "- ADVISORY kinds (order_by, partitioning, engine, denormalize, ingestion,",
  "  query_rewrite) CANNOT be applied in place. Leave `statements` EMPTY and put",
  "  the migration path in `migration`. A sort key change means creating a new",
  "  table with the right ORDER BY, backfilling with INSERT INTO … SELECT, and",
  "  swapping with EXCHANGE TABLES — say that, do not pretend an ALTER exists.",
  "- DO NOT propose column type changes as appliable. The rulebook still lists",
  "  `column_type` (ALTER TABLE … MODIFY COLUMN … <type>) under APPLIABLE, but",
  "  that ALTER schedules a background mutation that rewrites the whole column",
  "  and saturates the cluster on a large table. Treat `column_type` as ADVISORY:",
  "  leave `statements` EMPTY and describe the change in `migration`. You may",
  "  still raise the finding — a String holding numbers is worth flagging — just",
  "  never as something to be applied.",
  "- A projection needs two statements (ADD then MATERIALIZE). So does a skip",
  "  index — ADD INDEX alone does nothing to existing data, it must be followed",
  "  by MATERIALIZE INDEX. Return them as separate array elements.",
  "- `column_codec` (MODIFY COLUMN … CODEC) also rewrites every part in the",
  "  background. It stays appliable, but when the column is large, say so in",
  "  `caveat`.",
  "- Do not propose something that already exists — the profile lists the skip",
  "  indices, projections and materialized views already defined.",
  "- `impact` should match the rule you cite.",
  "- `estimate` is a dashboard chip: \"-60% storage\", \"145ms → ~3ms\". Reasoning",
  "  goes in `rationale`, not here.",
  "- `finding`: two or three sentences of plain language, no SQL.",
  "- Report what you actually found. Several real findings beat a full page of",
  "  marginal ones, and finding little is a legitimate result.",
].join("\n");

function renderEvidence(analysis: QueryLogAnalysis): string {
  if (analysis.patterns.length === 0) {
    return "(no recurring query patterns in this window)";
  }
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

function renderCase(analysis: QueryLogAnalysis, profile: PhysicalProfile): string {
  return [
    `Query window: last ${analysis.windowDays} days.`,
    `${analysis.totalQueries} queries across ${analysis.distinctPatterns} distinct patterns.`,
    "",
    "== Recurring query patterns (heaviest first) ==",
    renderEvidence(analysis),
    "",
    "== Physical profile of the tables ==",
    renderProfile(profile),
    profile.materializedViews.length
      ? `\nMaterialized views already defined: ${profile.materializedViews.join(", ")}`
      : "\nNo materialized views are defined yet.",
    "",
    "== Rulebook ==",
    renderRulebook(),
  ].join("\n");
}

// --- the task --------------------------------------------------------------

const TunePayload = z.object({
  windowDays: z.number().int().positive().max(90).optional(),
  patternLimit: z.number().int().positive().max(30).optional(),
});

/** At most this many findings reach the page — a shortlist, not a backlog. */
const MAX_FINDINGS = 12;

export const tuneTask = schemaTask({
  id: "tune",
  schema: TunePayload,
  maxDuration: 3600,
  retry: { maxAttempts: 1 },

  run: async (payload) => {
    const windowDays = payload.windowDays ?? 14;

    const initial: TuneMetadata = {
      status: "analyzing",
      windowDays,
      finding: null,
      analysis: null,
      profileSummary: null,
      approvalTokenId: null,
      findings: [],
    };
    metadata.replace(initial);

    // 1. Read both kinds of evidence: what was asked, and how it is stored.
    const [analysis, profile] = await Promise.all([
      analyzeQueryLog({ windowDays, limit: payload.patternLimit ?? 10 }),
      profilePhysical(),
    ]);
    metadata.set("analysis", analysis).set("profileSummary", {
      tables: profile.tables.length,
      columns: profile.tables.reduce((n, t) => n + t.columns.length, 0),
    });

    if (profile.tables.length === 0) {
      metadata
        .set("status", "done")
        .set("finding", "No MergeTree tables found — nothing to analyse.");
      return { windowDays, findings: 0, applied: 0 };
    }

    const brief = renderCase(analysis, profile);

    // 2. Investigate. The tool loop is where suspicions become measurements;
    //    a generous step budget because each check is one cheap read.
    metadata.set("status", "investigating");
    const investigation = await generateText({
      model: anthropic("claude-sonnet-5"),
      tools: diagnosticTools,
      // Each step is a full model round-trip, not just a cheap read — so the
      // budget is what the investigation COSTS in wall time, not how thorough it
      // can be. 12 is plenty to sample the categoricals, check a couple of
      // conversions and confirm the recurring patterns; 24 mostly bought a second
      // pass over the same ground at double the latency.
      stopWhen: stepCountIs(12),
      maxOutputTokens: 8000,
      system: INVESTIGATE_PROMPT,
      prompt: brief,
    });

    // 3. Write it up as structured findings. A separate call, deliberately:
    //    forcing a schema onto the same call that is running tools makes the
    //    model economise on investigation to satisfy the shape.
    metadata.set("status", "proposing");
    // generateObject throws AI_NoObjectGeneratedError when the model's reply
    // does not parse to the schema — an occasional, TRANSIENT formatting miss
    // (verified: the same call succeeded on one run and failed on the very next,
    // same code, same input). Left unguarded it discards the whole ~5-minute
    // investigation over one bad completion, and the page then shows the run's
    // findings as empty. So retry a few times before giving up; the retry almost
    // always lands. maxOutputTokens is generous so a verbose report can't be the
    // cause of a truncated, unparseable reply either.
    let object: z.infer<typeof FindingsResult> | null = null;
    let lastReportError: unknown = null;
    for (let attempt = 0; attempt < 3 && !object; attempt++) {
      try {
        const result = await generateObject({
          model: anthropic("claude-sonnet-5"),
          schema: FindingsResult,
          maxOutputTokens: 24000,
          system: REPORT_PROMPT,
          prompt: [
            brief,
            "",
            "== Your investigation ==",
            investigation.text,
            "",
            "Write up the findings.",
          ].join("\n"),
        });
        object = result.object;
      } catch (cause) {
        lastReportError = cause;
      }
    }
    if (!object) {
      throw lastReportError instanceof Error
        ? lastReportError
        : new Error("Could not generate the findings report.");
    }

    // 4. Shape the findings. Advisory ones are terminal on arrival: statements
    //    stripped here, so no code path downstream could execute them even if
    //    the model wrote DDL for one.
    const states: FindingState[] = object.findings
      .slice(0, MAX_FINDINGS)
      .map((finding, index) => {
        // The model often inlines a backfill INSERT among an MV's statements.
        // Backfill is a SEPARATE, opt-in step (the card's toggle drives
        // backfillMaterializedView, which reconstructs the INSERT from the view
        // itself), and an INSERT fails the MV shape guard anyway — the "Refusing
        // DDL that does not match a materialized_view statement: INSERT INTO …"
        // error. So an MV finding keeps only its CREATE statements (the target
        // table + the view); anything else is dropped here, before it can block
        // the apply.
        const statements =
          finding.kind === "materialized_view"
            ? finding.statements.filter((s) => /^\s*create\b/i.test(s.trim()))
            : finding.statements;
        const appliable =
          tuneCanApply(finding.kind) && statements.length > 0;
        return {
          ...finding,
          statements: appliable ? statements : [],
          id: `f${index}`,
          status: appliable ? ("pending" as const) : ("advisory" as const),
        };
      });

    metadata.set("finding", object.finding).set("findings", states);

    const pending = states.filter((s) => s.status === "pending");
    if (pending.length === 0) {
      metadata.set("status", "done");
      return { windowDays, findings: states.length, applied: 0 };
    }

    // 5. Approve → apply → re-park, until nothing appliable is left to decide.
    //    Each Apply from the page completes the current token; the run applies
    //    ONLY the ticked findings, LEAVES the rest as they were, and parks again
    //    on a fresh token. So the reader can apply one finding, go verify it
    //    (e.g. optimize a board against the new MV), come back and apply another,
    //    and RETRY one that failed — all WITHOUT paying the multi-minute
    //    investigation again. One run, many applies. An empty approval (the
    //    page's "Dismiss all") ends the session by dismissing whatever is left.
    //
    //    One token per ROUND, not per finding: Trigger.dev has no parallel waits,
    //    and "read the report, tick some, apply" is one action per round.
    //
    //    A finding is "open" (re-offerable) while pending OR failed — a failure
    //    is a retry candidate (a transient timeout, or a fix shipped meanwhile).
    //    Applied and dismissed are terminal.
    const isOpen = (s: FindingState) =>
      s.status === "pending" || s.status === "failed";

    while (states.some(isOpen)) {
      const token = await wait.createToken({
        timeout: "24h",
        tags: ["tune-approval"],
      });
      metadata
        .set("approvalTokenId", token.id)
        .set("status", "awaiting_approval");

      const result = await wait.forToken<TuneApproval>(token.id);
      const approvedIds = new Set(result.ok ? result.output.approved : []);
      // The subset of approved MV findings the reader also asked us to populate.
      // It rides in the same completion payload — one token, one decision.
      const backfillIds = new Set(
        result.ok ? (result.output.backfill ?? []) : [],
      );
      const decidedAt = new Date().toISOString();
      metadata.set("status", "applying");

      // Empty approval = "I'm done" — dismiss everything still open and stop.
      if (approvedIds.size === 0) {
        for (const state of states) {
          if (isOpen(state)) {
            state.status = "dismissed";
            state.decidedAt = decidedAt;
          }
        }
        break;
      }

      // Apply the ticked findings, in order. Sequential rather than concurrent:
      // these are DDL against one cluster, and a predictable order makes a
      // partial failure legible. A ticked FAILED finding is retried from scratch
      // (clear its prior error first). Unticked findings are left untouched, so
      // they are offered again on the next park rather than dismissed.
      for (const state of states) {
        if (!isOpen(state) || !approvedIds.has(state.id)) continue;
        state.decidedAt = decidedAt;
        state.error = undefined;

        try {
          for (const statement of state.statements) {
            assertAllowedDdl(state.kind, statement);
            await assertConversionsAreSafe(state.targetTable, statement);
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
        metadata.set("findings", states);

        // A fresh MV sees only future inserts, so on a static dataset its target
        // is empty until we replay the source through it. Do that only when the
        // view was actually created (status applied) and the reader ticked it
        // for backfill. It tracks its own status and never throws, so a heavy or
        // failed backfill cannot undo the successful CREATE above.
        if (
          state.status === "applied" &&
          state.kind === "materialized_view" &&
          backfillIds.has(state.id)
        ) {
          await backfillMaterializedView(state, states);
        }
      }
    }

    metadata.set("findings", states).set("status", "done");

    return {
      windowDays,
      findings: states.length,
      applied: states.filter((s) => s.status === "applied").length,
    };
  },
});

/** Impact ordering for callers that rank findings. Re-exported for the page. */
export type { Impact, OptimizationKind };
export { kindSpec };

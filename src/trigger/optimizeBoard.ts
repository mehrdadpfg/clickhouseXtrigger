/**
 * Optimize a board's tiles to read from materialized views.
 *
 * The read → act shift, applied to a dashboard. A board's tiles each hold a
 * query — usually against a large base table, re-run live on every load. Once
 * Tune has created materialized views that pre-aggregate what those tiles
 * compute, this task rewrites each tile's SQL to read from the view's target
 * table instead, turning a full scan into a lookup.
 *
 * It is deliberately shaped like `tune`, and for the same reason: rewriting a
 * tile's stored query is a change the reader must SEE and approve, not something
 * a model does silently behind a button. So the run proposes — publishing the
 * per-tile before/after to run metadata, which the board's Optimize panel
 * renders as a diff — then parks on ONE waitpoint token for the whole board.
 * It applies only the tiles the reader ticked, when they complete that token.
 *
 * One token for the batch (not one per tile) mirrors tune: Trigger.dev does not
 * support parallel waits, and "review the whole set, apply once" is the right
 * shape for a diff the reader is meant to read before committing.
 *
 * The rewrite itself is a model call. It only ever REPOINTS a query at an
 * existing view and adjusts the aggregation mechanics; the guard below refuses
 * any proposed SQL that is not a single read, so a rewrite can never do more
 * than the original tile could.
 */
import { metadata, schemaTask, wait } from "@trigger.dev/sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { clickhouse, READONLY_SETTINGS } from "@/lib/clickhouse/client";
import { listTiles, updateTile } from "@/lib/db/boards";

// --- shapes shared with the reading side -----------------------------------

export type OptimizeStatus =
  | "analyzing"
  | "awaiting_approval"
  | "applying"
  | "done";

export type ProposalStatus = "proposed" | "applied" | "failed" | "dismissed";

/** One tile's before/after, as the panel renders it. */
export type OptimizeProposal = {
  tileId: string;
  title: string;
  oldSql: string;
  newSql: string;
  /** True only when the rewrite is a real, read-only change from the original. */
  changed: boolean;
  /** The view/target table it now reads, for the panel's label. */
  mvUsed: string;
  /** Why it changed, or why it was left alone. */
  note: string;
  status: ProposalStatus;
  error?: string;
};

export type OptimizeMetadata = {
  status: OptimizeStatus;
  boardId: string;
  /** How many materialized views were available to rewrite against. */
  mvCount: number;
  /** The one token gating the rewrites. Server-only — the page never sees it. */
  approvalTokenId: string | null;
  proposals: OptimizeProposal[];
  summary: string;
};

/** The reader's decision: which tiles, by id, to repoint. */
export type OptimizeApproval = { approved: string[] };

// --- the model's rewrite ---------------------------------------------------

const RewriteResult = z.object({
  /** One or two sentences on what was repointed and what was left alone. */
  summary: z.string(),
  tiles: z.array(
    z.object({
      tileId: z.string(),
      changed: z.boolean(),
      /** The rewritten query, or the original verbatim when nothing applies. */
      newSql: z.string(),
      mvUsed: z.string().default(""),
      note: z.string().default(""),
    }),
  ),
});

const OPTIMIZE_PROMPT = [
  "You are a ClickHouse optimizer. You repoint dashboard tile queries at",
  "materialized views so a full base-table scan becomes a cheap lookup.",
  "",
  "You are given the board's tiles (each with an id and its current SQL) and the",
  "materialized views defined in the database — each view's own SELECT (what it",
  "aggregates and its GROUP BY) and the CREATE of its target table (the columns",
  "and the ENGINE where its rows actually land).",
  "",
  "For EACH tile, decide whether a view's target table can answer it faster:",
  "- It can when the view pre-aggregates, at the same or finer grain, exactly the",
  "  measure and dimensions the tile computes from the base table.",
  "- If so, rewrite the tile's SQL to read FROM the target table, adjusting the",
  "  aggregation to the target's engine:",
  "  * AggregatingMergeTree stores intermediate states — read them with the",
  "    -Merge combinators (sumMerge, countMerge, uniqMerge, quantileMerge, …) and",
  "    keep a GROUP BY on the stored dimensions.",
  "  * SummingMergeTree pre-sums the measure columns — SUM them (a final GROUP BY",
  "    collapses parts) or read plain when already at target grain.",
  "  * A plain MergeTree rollup is read as-is.",
  "- The rewrite MUST preserve the tile's output columns, their names, their",
  "  ordering (ORDER BY / LIMIT) and its exact meaning. Only the source table and",
  "  the aggregation mechanics change — never the shape of the result.",
  "",
  "Return every tile. When no view serves a tile, set changed=false and return",
  "its ORIGINAL SQL verbatim in newSql, with a one-line note saying why. Never",
  "invent a table, column or view that is not in what you were given. newSql is",
  "always ONE read-only SELECT (a WITH/CTE is fine) — never DDL, never a write.",
].join("\n");

// --- the guard -------------------------------------------------------------

/**
 * A rewritten tile query must be a single read. Belt-and-braces on top of the
 * prompt: the tile's SQL is executed live on the board, so a rewrite that
 * smuggled in a second statement or a write must never be stored. Mirrors the
 * shape check the chat and board editors already apply to author-typed SQL.
 */
function isSingleRead(sql: string): boolean {
  const s = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (s.includes(";")) return false;
  if (!/^(select|with)\b/i.test(s)) return false;
  return !/\b(insert|alter|create|drop|truncate|delete|attach|detach|rename|optimize|grant|revoke)\b/i.test(
    s,
  );
}

/**
 * The materialized views (and their small target tables) available to rewrite
 * against. `as_select` is the view's own query; `create_table_query` carries
 * the TO target and, for the target rows, the ENGINE and columns. Base tables
 * are excluded by size — a rollup target is tiny next to the table it rolls up.
 */
async function discoverViews(): Promise<
  { name: string; engine: string; as_select: string; create_table_query: string }[]
> {
  const rs = await clickhouse.query({
    query: `
      SELECT name, engine, create_table_query,
             multiIf(engine = 'MaterializedView', as_select, '') AS as_select
      FROM system.tables
      WHERE database = 'default'
        AND (engine = 'MaterializedView'
             OR (engine LIKE '%MergeTree%' AND total_rows < 100000000))
      ORDER BY engine = 'MaterializedView' DESC, name`,
    format: "JSONEachRow",
    clickhouse_settings: READONLY_SETTINGS,
  });
  return rs.json();
}

// --- the task --------------------------------------------------------------

export const optimizeBoardTask = schemaTask({
  id: "optimize-board",
  schema: z.object({ boardId: z.string().min(1) }),
  run: async ({ boardId }) => {
    metadata
      .set("status", "analyzing")
      .set("boardId", boardId)
      .set("mvCount", 0)
      .set("approvalTokenId", null)
      .set("proposals", [])
      .set("summary", "");

    const tiles = await listTiles(boardId);
    if (tiles.length === 0) {
      metadata.set("status", "done").set("summary", "This board has no tiles.");
      return { boardId, changed: 0, applied: 0 };
    }

    const views = await discoverViews();
    const mvCount = views.filter((v) => v.engine === "MaterializedView").length;
    metadata.set("mvCount", mvCount);
    if (mvCount === 0) {
      metadata
        .set("status", "done")
        .set(
          "summary",
          "No materialized views are defined yet — create some in Tune first, then optimize.",
        );
      return { boardId, changed: 0, applied: 0 };
    }

    // Ask the model to repoint each tile at a view where one serves it.
    const { object } = await generateObject({
      model: anthropic("claude-sonnet-5"),
      schema: RewriteResult,
      maxOutputTokens: 12000,
      system: OPTIMIZE_PROMPT,
      prompt: [
        "== Board tiles ==",
        ...tiles.map((t) => `[tile ${t.id}] "${t.title}"\n${t.sql}`),
        "",
        "== Materialized views and their target tables ==",
        ...views.map((v) =>
          v.engine === "MaterializedView"
            ? `VIEW ${v.name}:\n  as_select: ${v.as_select}\n  ${v.create_table_query}`
            : `TABLE ${v.name} (${v.engine}):\n  ${v.create_table_query}`,
        ),
        "",
        "Rewrite the tiles that a view can serve; return the rest unchanged.",
      ].join("\n"),
    });

    // Reconcile the model's answer against the real tiles: a rewrite only counts
    // as `changed` when it is a genuine, read-only difference from the original.
    const byId = new Map(tiles.map((t) => [t.id, t]));
    const proposals: OptimizeProposal[] = [];
    for (const tile of tiles) {
      const rewrite = object.tiles.find((r) => r.tileId === tile.id);
      const proposed = rewrite?.newSql?.trim() ?? "";
      const changed =
        !!rewrite?.changed &&
        proposed.length > 0 &&
        proposed !== tile.sql.trim() &&
        isSingleRead(proposed);
      proposals.push({
        tileId: tile.id,
        title: tile.title,
        oldSql: tile.sql,
        newSql: changed ? proposed : tile.sql,
        changed,
        mvUsed: changed ? (rewrite?.mvUsed ?? "") : "",
        note: rewrite?.note ?? "",
        status: "proposed",
      });
    }
    metadata.set("proposals", proposals).set("summary", object.summary);

    const changedCount = proposals.filter((p) => p.changed).length;
    if (changedCount === 0) {
      metadata
        .set("status", "done")
        .set(
          "summary",
          object.summary ||
            "No tile could be served by an existing view — nothing to change.",
        );
      return { boardId, changed: 0, applied: 0 };
    }

    // Park on one token for the whole board — the reader reviews the diff and
    // ticks which tiles to repoint. Costs nothing while parked.
    const token = await wait.createToken({
      timeout: "24h",
      tags: ["optimize-approval"],
    });
    metadata.set("approvalTokenId", token.id).set("status", "awaiting_approval");

    const result = await wait.forToken<OptimizeApproval>(token.id);
    const approved = new Set(result.ok ? result.output.approved : []);
    metadata.set("status", "applying");

    // Apply the approved rewrites, in order. Each is a Postgres write of the
    // tile's stored SQL — the next board load simply runs the new query.
    for (const proposal of proposals) {
      if (!proposal.changed) continue;
      if (!approved.has(proposal.tileId)) {
        proposal.status = "dismissed";
        continue;
      }
      try {
        await updateTile(proposal.tileId, { sql: proposal.newSql });
        proposal.status = "applied";
      } catch (cause) {
        proposal.status = "failed";
        proposal.error =
          cause instanceof Error ? cause.message : "Could not update the tile.";
      }
      metadata.set("proposals", proposals);
    }

    metadata.set("proposals", proposals).set("status", "done");
    return {
      boardId,
      changed: changedCount,
      applied: proposals.filter((p) => p.status === "applied").length,
    };
  },
});

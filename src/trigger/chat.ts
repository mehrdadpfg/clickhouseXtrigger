import { ai, chat } from "@trigger.dev/sdk/ai";
import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { clickhouse, READONLY_SETTINGS } from "@/lib/clickhouse/client";
import { describeTable, listTables } from "@/lib/clickhouse/introspect";
import { saveMessages } from "@/lib/db/messages";
import { saveSession } from "@/lib/db/sessions";
import {
  createWatcherCore,
  deleteWatcherCore,
  updateWatcherCore,
} from "@/lib/watchers/create";
import { listWatchersForChat } from "@/lib/db/watchers";
import { loadMentionedBoardsContext } from "@/lib/boards/mentionContext";
import { loadMentionedWatchersContext } from "@/lib/watchers/mentionContext";
import type { WatcherThreshold } from "@/types/db";

const tools = {
  listTables: tool({
    description:
      "List the tables and views available in the configured ClickHouse " +
      "database, with their engine and row count. Call this when you don't yet " +
      "know what data exists — before writing any SQL, and before offering " +
      "tables as presentChoices options. Do NOT call it again once you have " +
      "listed them in this conversation; the list does not change mid-chat.",
    inputSchema: z.object({
      database: z
        .string()
        .optional()
        .describe(
          "Restrict to one database. Omit to list every non-system database.",
        ),
    }),
    execute: async ({ database }) => listTables(database),
  }),

  describeTable: tool({
    description:
      "Get the columns, types and sorting key of one table. Call this before " +
      "writing SQL against a table you have not described yet, so column names " +
      "and types are read from the live schema rather than guessed — and call " +
      "it again after a query fails on an unknown column. Skip it for a table " +
      "you already described this conversation. Returns { error } if the table " +
      "does not exist; re-check the name against listTables rather than retrying.",
    inputSchema: z.object({
      database: z
        .string()
        .describe(
          "The database the table lives in, exactly as listTables spelled it.",
        ),
      table: z
        .string()
        .describe(
          "The table name on its own, without the database prefix — 'trips', not 'nyc.trips'.",
        ),
    }),
    execute: async ({ database, table }) => {
      const schema = await describeTable(database, table);
      return schema ?? { error: `No table ${database}.${table}.` };
    },
  }),

  queryClickhouse: tool({
    description:
      "Run a read-only SQL SELECT against the configured ClickHouse database. " +
      "This is the ONLY way to read data — every number you report must come " +
      "from a result of this tool. Returns the rows as an array of objects " +
      "(one key per selected column), which the UI renders as a table on its " +
      "own, so don't re-list the rows in your reply.\n\n" +
      "Prefer aggregates over raw rows: GROUP BY, count(), avg(), a date " +
      "bucket. Always add a LIMIT when you select rows instead of aggregates — " +
      "tables here can be very large. Describe a table before querying it, and " +
      "re-describe it if the query errors on an unknown column.",
    inputSchema: z.object({
      sql: z
        .string()
        .describe(
          "ONE ClickHouse SELECT statement. Qualify every table as db.table. " +
            "No trailing semicolon, no FORMAT clause, no multiple statements, " +
            "and nothing that writes (INSERT, ALTER, CREATE, DROP) — those are " +
            "rejected by the connection's read-only settings.",
        ),
    }),
    execute: async ({ sql }) => {
      try {
        const resultSet = await clickhouse.query({
          query: sql,
          format: "JSONEachRow",
          clickhouse_settings: READONLY_SETTINGS,
        });
        return await resultSet.json();
      } catch (err) {
        // Hand the model the REAL ClickHouse error instead of throwing. A thrown
        // tool error reaches the agent only as the SDK's generic "An error
        // occurred.", so it can't tell a timeout from a bad column and just
        // guesses a workaround (or silently drops the analysis). The actual
        // message — TIMEOUT_EXCEEDED, MEMORY_LIMIT_EXCEEDED, an unknown column —
        // is what lets it narrow the scan, re-read the schema, or retry. Returned
        // (not thrown) so it lands as a normal tool result the next step reads.
        const message = err instanceof Error ? err.message : String(err);
        return { error: message.slice(0, 800) };
      }
    },
  }),

  renderChart: tool({
    description:
      "Render a chart from rows you already fetched with queryClickhouse, when " +
      "the shape of the data (a trend, a ranking, a distribution) is the point " +
      "and reads better as a chart than prose. Call it only AFTER the query " +
      "that produced the rows — never with numbers you wrote yourself.\n\n" +
      "Do NOT call it when: the answer is one number (that is renderStat); the " +
      "reader asked for the rows themselves (queryClickhouse already renders " +
      "them as a table); or there are fewer than ~3 points, where a chart adds " +
      "nothing. When the turn draws a chart, the query's own table is hidden — " +
      "the chart stands for the result.\n\n" +
      "PICK chartType from the SHAPE of the result, not by habit. Bar, line and " +
      "pie are the reflex, but they fit maybe a third of results — name the " +
      "shape first, then take its chart:\n" +
      "- One measure over time → Line Chart (Area Chart to stress volume, " +
      "Streamgraph for many stacked series).\n" +
      "- Ranking of many categories → horizontal Bar Chart, or Lollipop Chart " +
      "when thin bars would crowd; set horizontal:true so labels stay level.\n" +
      "- Composition / part-to-whole → Pie Chart for a few slices (≤6), Treemap " +
      "for many, Sunburst Chart when the parts nest (category → subcategory).\n" +
      "- Stage-by-stage drop-off → Funnel Chart (or Pyramid Chart for an " +
      "age/size structure).\n" +
      "- Distribution of one measure → Histogram, or Boxplot to compare that " +
      "spread across groups.\n" +
      "- Two measures against each other → Scatter Plot (add size and color for " +
      "a third and fourth dimension).\n" +
      "- Flow BETWEEN nodes (A→B volumes) → Sankey Diagram.\n" +
      "- A grid of two categories → Heatmap; the same measure over dates → " +
      "Calendar Heatmap.\n" +
      "- A few items compared across several metrics at once → Radar Chart.\n" +
      "- One value against a target or range → Gauge Chart or Bullet Chart " +
      "(prefer renderStat for a lone number; reach here only when the target is " +
      "the point).\n" +
      "Fall back to a plain vertical Bar Chart only when the result is a handful " +
      "of categories with one measure and nothing above fits better. Reach for " +
      "the richer type when the data truly has that shape — the right chart, " +
      "never a novel one for its own sake. Then map every channel that type " +
      "uses to a row field in `encodings`.\n\n" +
      "Channel guide (set only the channels the chart uses):\n" +
      "- Trend over time — Line Chart, Area Chart, Streamgraph, Bump Chart, " +
      "Slope Chart, Range Area Chart(x,y,y2): x=time, y=measure, color=series.\n" +
      "  Comparing TWO measures over time (e.g. stars vs forks — both counts): " +
      "they share ONE axis as two lines. SELECT them in long form — a label " +
      "column and a value column, e.g. SELECT year, 'stars' AS metric, s AS " +
      "value … UNION ALL … 'forks' … — and set {x:year, y:value, color:metric}. " +
      "Do NOT put the second measure on y2; y2 is only for a genuinely DIFFERENT " +
      "scale/unit (Range Area Chart), never for two measures of the same unit.\n" +
      "- Rank / compare categories — Bar Chart, Grouped Bar Chart(x,y,group), " +
      "Stacked Bar Chart, Lollipop Chart, Waterfall Chart, Rose Chart: " +
      "x=category, y=measure, color=series. Set horizontal:true for long labels.\n" +
      "- Part-to-whole — Pie Chart, Funnel Chart, Pyramid Chart, Treemap, " +
      "Sunburst Chart: color=category, size=value.\n" +
      "- Relationship — Scatter Plot(x,y,size,color), Connected Scatter Plot, " +
      "Regression, Ranged Dot Plot: x, y, size=bubble, color.\n" +
      "- Distribution — Histogram(x), Density Plot(x), Boxplot(x,y), Strip Plot, " +
      "ECDF Plot(x): x=value, color=group.\n" +
      "- Matrix — Heatmap(x,y,color), Calendar Heatmap(x,color).\n" +
      "- Indicator — Radar Chart(x,y,color), Gauge Chart(size), " +
      "Bullet Chart(y,x,goal).\n" +
      "- Financial — Candlestick Chart(x,open,high,low,close). " +
      "Flow — Sankey Diagram(x,y,size).",
    inputSchema: z.object({
      chartType: z
        .enum([
          "Line Chart", "Area Chart", "Streamgraph", "Bump Chart", "Slope Chart",
          "Range Area Chart", "Bar Chart", "Grouped Bar Chart", "Stacked Bar Chart",
          "Lollipop Chart", "Waterfall Chart", "Rose Chart", "Pie Chart",
          "Funnel Chart", "Pyramid Chart", "Treemap", "Sunburst Chart",
          "Scatter Plot", "Connected Scatter Plot", "Regression", "Ranged Dot Plot",
          "Histogram", "Density Plot", "Boxplot", "Strip Plot", "ECDF Plot",
          "Heatmap", "Calendar Heatmap", "Radar Chart", "Gauge Chart",
          "Bullet Chart", "Candlestick Chart", "Sankey Diagram",
        ])
        .describe("The chart template, chosen by the data's job (see families above)."),
      title: z.string().describe("Short chart title."),
      encodings: z
        .record(z.string(), z.string())
        .describe(
          "Map each channel the chart uses to a row field name, e.g. " +
            '{"x":"month","y":"revenue","color":"region"}; a pie is ' +
            '{"color":"payment_type","size":"trips"}.',
        ),
      data: z
        .array(z.record(z.string(), z.unknown()))
        .describe("The rows fetched from queryClickhouse, passed through as-is."),
      sql: z
        .string()
        .min(1)
        .max(8000)
        .describe(
          "The exact queryClickhouse SQL that produced these rows, verbatim. The chart carries it so the reader can open it, edit the query and re-run it, and pin the chart to a board — all three are disabled on a chart with no SQL, so this is load-bearing, not documentation. Copy the string you passed to queryClickhouse; do not paraphrase, re-indent or re-derive it.",
        ),
      horizontal: z
        .boolean()
        .optional()
        .describe("Bar family only: lay bars horizontally so long category labels stay readable."),
      semanticTypes: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Optional field→semantic hint (Quantity, Time, Year, Percentage, " +
            "Country, Rank) to improve axis scaling and number formatting.",
        ),
    }),
    // Validate and echo the spec back unchanged. Compilation to ECharts (via
    // flint-chart's assembleECharts) is a client concern — importing echarts or
    // flint here would pull a browser-only bundle into the task. Returning the
    // spec is enough: the frontend picks it up from the tool-call part.
    execute: async (spec) => spec,
  }),

  renderStat: tool({
    description:
      "Render ONE headline number as a KPI stat tile, AFTER you have the value " +
      "from queryClickhouse. Use this whenever the answer IS a single figure — a " +
      "total, a count, an average, a rate, a max — instead of a 1x1 table or, " +
      "worse, a 1-bar chart. Pass the metric's name as `label` and the number " +
      "as `value`; add a `unit` if it has one, and an optional `delta` (percent " +
      "change vs a prior period) when the query gave you a comparison. The tile " +
      "is pinnable to a board as a KPI, so the label should read as the metric " +
      "itself (e.g. \"Total towers\", \"Avg trip distance\"), not a sentence.\n\n" +
      "One call per number — several calls in a turn tile into a KPI strip, " +
      "which is how an overview leads with its headline figures. Do NOT call it " +
      "for a number you did not just query, for a column of values (that is a " +
      "chart or a table), or to restate a figure a chart already plots.",
    inputSchema: z.object({
      label: z
        .string()
        .describe(
          'The metric\'s name, e.g. "Total towers" or "Avg trip distance".',
        ),
      value: z
        .number()
        .describe("The single number, exactly as your query computed it."),
      unit: z
        .enum(["", "$", "%", "×"])
        .optional()
        .describe(
          "Display unit: '$' leads the number, '%' and '×' trail it; omit or " +
            "'' for a plain number. Use '%' ONLY when `value` genuinely IS a " +
            "percentage (0–100 — a rate or a share you computed), NEVER on a raw " +
            "count or total. A count like 1,600,000,000 events takes unit '', " +
            "not '%'.",
        ),
      delta: z
        .number()
        .optional()
        .describe(
          "Percent change vs a comparison period, e.g. 11.8 for +11.8%. The " +
            "sign carries the direction; only set it if the query produced one.",
        ),
      deltaLabel: z
        .string()
        .optional()
        .describe('What the delta compares against, e.g. "vs Jun".'),
      upIsGood: z
        .boolean()
        .optional()
        .describe(
          "Whether a rising value is good news (revenue up is good; latency or " +
            "error rate up is not). Defaults to true.",
        ),
    }),
    // Echo the spec back unchanged, exactly like renderChart: the number and its
    // framing are already in hand, so the tile is a pure client render.
    execute: async (spec) => spec,
  }),

  createWatcher: tool({
    description:
      "Turn a question into a standing watcher: a SQL query re-run on a schedule " +
      "that raises an alert when a threshold is crossed. Use this when the user " +
      "asks to be told/alerted/notified WHEN something happens ('tell me when …', " +
      "'alert me if …', 'watch …'), not for a one-off answer. The SQL must be a " +
      "single read-only SELECT that returns ONE number (the metric to compare) — " +
      "aggregate it down to a scalar.\n\n" +
      "Get the threshold from askThreshold first; do not invent one. The result " +
      "renders as a confirmation card showing the question, cadence and " +
      "threshold, so say at most one short sentence about it and never repeat " +
      "those values in prose.",
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "The standing question in plain language, e.g. 'Average fare drops 20% week over week'.",
        ),
      sql: z
        .string()
        .min(1)
        .max(8000)
        .describe(
          "A single read-only SELECT returning ONE number — the metric the threshold is checked against. Qualify tables as db.table; no trailing semicolon.",
        ),
      schedule: z
        .enum(["5m", "1h", "6h", "daily"])
        .describe("How often to re-run the check."),
      direction: z
        .enum(["rises_above", "drops_below", "changes_by"])
        .describe(
          "How the metric crosses the threshold. 'changes_by' compares against a four-week average.",
        ),
      value: z
        .number()
        .describe("The threshold number. For 'changes_by' it is a percent, e.g. 20 for 20%."),
      unit: z
        .enum(["$", "%", "×"])
        .optional()
        .describe("Display unit for the threshold, if it has one."),
    }),
    execute: async ({ question, sql, schedule, direction, value, unit }) => {
      const threshold: WatcherThreshold = {
        direction,
        value,
        ...(unit ? { unit } : {}),
        // The only baseline the schema knows; meaningful for changes_by alone.
        ...(direction === "changes_by"
          ? { baseline: "four_week_average" as const }
          : {}),
      };
      // Link the watcher to this conversation so a later alert can reopen it.
      const chatId = ai.chatContext()?.chatId ?? null;
      const result = await createWatcherCore({
        question,
        sql,
        schedule,
        threshold,
        chatId,
      });
      return result.ok
        ? {
            ok: true,
            watcherId: result.watcher.id,
            question,
            schedule,
            direction,
            value,
            ...(unit ? { unit } : {}),
            summary: `Watcher created — re-runs ${schedule}, alerts when it ${direction.replace(/_/g, " ")} ${value}${unit ?? ""}.`,
          }
        : { ok: false, error: result.error };
    },
  }),

  listWatchers: tool({
    description:
      "List the watchers created in THIS conversation, with their id, question, " +
      "schedule, threshold and state. Call this first when the user wants to " +
      "edit, pause, resume or delete a watcher but hasn't given its id — match " +
      "their words to a watcher here, then act on its id with editWatcher or " +
      "deleteWatcher. Skip it when you already have the id from a createWatcher " +
      "earlier in this conversation. Watchers from other conversations are not " +
      "listed, so an empty list means none were made here, not none exist.",
    inputSchema: z.object({}),
    execute: async () => {
      const chatId = ai.chatContext()?.chatId;
      if (!chatId) return { watchers: [] };
      const rows = await listWatchersForChat(chatId);
      return {
        watchers: rows.map((w) => ({
          id: w.id,
          question: w.question,
          schedule: w.schedule,
          state: w.state,
          threshold: `${w.threshold.direction.replace(/_/g, " ")} ${w.threshold.value}${w.threshold.unit ?? ""}`,
        })),
      };
    },
  }),

  editWatcher: tool({
    description:
      "Edit an existing watcher (pass its id from listWatchers or a prior " +
      "createWatcher). Change only the fields the user asked about — omit the " +
      "rest — an omitted field keeps its current value. Set `state` to 'paused' " +
      "or 'active' to pause/resume it. To change the alert threshold, pass " +
      "direction AND value together (with unit if any); passing one without the " +
      "other leaves the threshold unchanged. The result renders as a card " +
      "showing the updated watcher, so don't restate its fields in prose.",
    inputSchema: z.object({
      watcherId: z.string().min(1).describe("The watcher's id."),
      question: z.string().min(1).max(200).optional().describe("New standing question."),
      sql: z
        .string()
        .min(1)
        .max(8000)
        .optional()
        .describe("New read-only SELECT returning ONE number."),
      schedule: z
        .enum(["5m", "1h", "6h", "daily"])
        .optional()
        .describe("New cadence."),
      direction: z
        .enum(["rises_above", "drops_below", "changes_by"])
        .optional()
        .describe("New threshold direction — pass together with value."),
      value: z.number().optional().describe("New threshold number."),
      unit: z.enum(["$", "%", "×"]).optional().describe("New threshold unit."),
      state: z
        .enum(["active", "paused"])
        .optional()
        .describe("Pause or resume the watcher."),
    }),
    execute: async ({ watcherId, question, sql, schedule, direction, value, unit, state }) => {
      const threshold: WatcherThreshold | undefined =
        direction !== undefined && value !== undefined
          ? {
              direction,
              value,
              ...(unit ? { unit } : {}),
              ...(direction === "changes_by"
                ? { baseline: "four_week_average" as const }
                : {}),
            }
          : undefined;
      const result = await updateWatcherCore({
        id: watcherId,
        ...(question !== undefined ? { question } : {}),
        ...(sql !== undefined ? { sql } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        ...(state !== undefined ? { state } : {}),
      });
      if (!result.ok) return { ok: false, error: result.error };
      const w = result.watcher;
      return {
        ok: true,
        updated: true,
        watcherId: w.id,
        question: w.question,
        schedule: w.schedule,
        direction: w.threshold.direction,
        value: w.threshold.value,
        ...(w.threshold.unit ? { unit: w.threshold.unit } : {}),
        state: w.state,
        summary: `Watcher updated — ${w.state}, re-runs ${w.schedule}, alerts when it ${w.threshold.direction.replace(/_/g, " ")} ${w.threshold.value}${w.threshold.unit ?? ""}.`,
      };
    },
  }),

  deleteWatcher: tool({
    description:
      "Delete a watcher for good (pass its id from listWatchers or a prior " +
      "createWatcher). Its alerts go with it. This can't be undone, so only do it " +
      "when the user clearly asks to remove/delete/stop-watching — to merely " +
      "stop it firing, use editWatcher with state 'paused' instead. The result " +
      "renders as a removal card, so one short sentence is enough in your reply.",
    inputSchema: z.object({
      watcherId: z.string().min(1).describe("The watcher's id."),
      question: z
        .string()
        .max(200)
        .optional()
        .describe(
          "The watcher's question, copied from listWatchers or the createWatcher " +
            "that made it. Pass it whenever you know it — the removal card names " +
            "the deleted watcher only if you do.",
        ),
    }),
    execute: async ({ watcherId, question }) => {
      const result = await deleteWatcherCore(watcherId);
      return result.ok
        ? { ok: true, deleted: true, watcherId: result.id, question: question ?? "", summary: "Watcher deleted." }
        : { ok: false, error: result.error };
    },
  }),

  askThreshold: tool({
    description:
      "Ask for the threshold that should trip a watcher, once the METRIC is " +
      "settled but the number isn't. Shows a small form — direction, value, " +
      "cadence — pre-filled from what you pass, and the reader's submit comes " +
      "back as their next message for you to hand to createWatcher.\n\n" +
      "Use this INSTEAD of asking for a threshold in prose, and instead of " +
      "presentChoices (which is for disambiguating WHICH thing, not for " +
      "picking a number). Do not call createWatcher until this form comes " +
      "back — its answer is where the threshold comes from.\n\n" +
      "`currentValue` is optional in the schema but required in practice: a " +
      "reader can only judge 'rises above 20,000' against what the metric reads " +
      "today, and seeding the form from the live number is most of this tool's " +
      "value. So run the scalar SELECT with queryClickhouse FIRST and pass what " +
      "it returned. Omit it only if that query failed.",
    inputSchema: z.object({
      metric: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "The settled metric in plain language, e.g. 'Trailing 12-month eviction count'.",
        ),
      sql: z
        .string()
        .min(1)
        .max(8000)
        .describe(
          "The scalar SELECT that reads this metric — ONE number. Echoed back with the reader's answer so you can create the watcher without rewriting it.",
        ),
      currentValue: z
        .number()
        .optional()
        .describe("What the metric reads right now, from your own query. Seeds the input."),
      unit: z
        .enum(["$", "%", "×"])
        .optional()
        .describe("Display unit, if the metric has one."),
      suggestedDirection: z
        .enum(["rises_above", "drops_below", "changes_by"])
        .describe("The direction that fits this metric — pre-selected in the form."),
      suggestedValue: z
        .number()
        .describe(
          "A defensible starting threshold, derived from currentValue (e.g. 20% above it), not a round guess.",
        ),
      suggestedSchedule: z
        .enum(["5m", "1h", "6h", "daily"])
        .describe("The cadence that fits how fast this metric moves."),
    }),
    // Echoed back unchanged; the form is a client concern, like renderChart.
    execute: async (spec) => spec,
  }),

  presentChoices: tool({
    description:
      "When the user's request is too vague to act on — you don't yet know which " +
      "table, metric, dimension, or option they mean — call this INSTEAD of " +
      "guessing or writing a paragraph of questions. It shows the user a labelled " +
      "list to pick from; their click sends that option's `value` verbatim as " +
      "the next user message, so the conversation continues without you asking " +
      "again. Populate the options from real data (e.g. call listTables first, " +
      "then offer each table as a choice) — never from guesses.\n\n" +
      "Do NOT use it when the intent is already clear enough to act, and do NOT " +
      "use it to collect a number: a threshold, a cadence or a direction goes " +
      "through askThreshold, which renders a form rather than a list of canned " +
      "combinations. When the choice is WHICH TABLE / dataset, offer EVERY user " +
      "table — the reader is choosing what to look at, and a curated few hides the " +
      "rest of their data. Only for a metric or dimension choice should you narrow " +
      "to the 2-8 that actually fit. If only one candidate is real, just act on it.",
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "The one-line prompt shown above the choices, e.g. 'Which table do you want to explore?'.",
        ),
      options: z
        .array(
          z.object({
            label: z
              .string()
              .min(1)
              .max(120)
              .describe("The choice text shown on the option, e.g. a table name."),
            value: z
              .string()
              .min(1)
              .max(400)
              .describe(
                "The message sent as the user's reply when this option is clicked. Make it a clear instruction, e.g. 'Give me an overview of the nyc_taxi table'.",
              ),
            hint: z
              .string()
              .max(120)
              .optional()
              .describe("Optional secondary line, e.g. a row count or short description."),
          }),
        )
        .min(2)
        // Was 8, which silently truncated a "which table?" list on a database
        // with more than eight tables — the reader was offered a subset of their
        // own data. High enough now to list every table; a metric/dimension
        // choice still stays small by the prompt guidance, not the schema.
        .max(40)
        .describe(
          "The choices to offer. For a table/dataset choice, list every user table; " +
            "for a metric or dimension, the 2-8 that fit.",
        ),
    }),
    // Pure client render, like renderChart: the spec IS the tile.
    execute: async (spec) => spec,
  }),
};

const SYSTEM_PROMPT = [
  "You are a data analyst working over a ClickHouse database.",
  "You do not know the schema in advance — discover it at runtime.",
  "",
  "Standing rules — these hold on EVERY turn, not just the first:",
  "- Never invent numbers, table names, or columns. Every figure you report comes from a queryClickhouse result; every identifier comes from listTables or describeTable.",
  "- NEVER pick a table for the reader. If the question does not name a table (via an @mention or by naming it) and does not clearly point at one (its columns or subject match a single table), and more than one table could plausibly answer, you MUST call presentChoices with the candidate tables — listTables first — and wait for the reader to choose. Silently analysing a table they did not ask about is the worst thing you can do here: it looks confident and answers a question nobody posed. Answer directly ONLY when exactly one table fits — the question is unmistakably about it, or it is the only user table.",
  "- Tables may be large. Aggregate in SQL — GROUP BY, count(), avg(), a date bucket — rather than pulling rows into context, and add a LIMIT whenever you select rows instead of aggregates.",
  "- Use the FULL SQL surface — match the query's complexity to the QUESTION, never flatten a question into the simplest thing that returns rows. When it genuinely needs more, reach for it: JOINs across tables; CTEs (WITH) to stage a computation; window functions (OVER (…), lagInFrame / leadInFrame for period-over-period and YoY, row_number / rank for top-N-within-group, running sums for growth and stagnation); and ClickHouse's array + higher-order power (groupArray, arrayJoin, uniqExact, quantile, topK, and arrayIntersect / has for affinity, overlap and cohort work). 'One SELECT per call' bounds the STATEMENT, not the ambition — a single SELECT can carry CTEs, joins, windows and arrays. Write the query the analysis actually needs; if one hits the read limit it just errors, so make that one narrower and retry — never pre-emptively dumb a query down.",
  "- Before building your analysis, brainstorm the range of analytical angles this data supports — rankings, distributions, trends over time, growth vs. decline, cohort/affinity between entities, extremes, per-group top-N — then pick the richest handful and pursue those, not just the obvious ones.",
  "- queryClickhouse is read-only: one SELECT per call, tables qualified as db.table, no trailing semicolon, no FORMAT clause, nothing that writes.",
  "- FIRE INDEPENDENT QUERIES TOGETHER. When several probes or tile queries don't depend on each other's results, emit them as multiple queryClickhouse calls in the SAME step — they run in parallel and the whole batch returns at once, instead of paying a separate round-trip per query. Only chain a query to a later step when it genuinely needs the previous one's output (e.g. you must learn the top-5 keys before querying within them). A dashboard's tile queries are mostly independent — batch them.",
  "- If a query errors, READ the error message it returns — it tells you the cause. A timeout / memory error means the scan was too big: narrow it (add a created_at range, bucket harder, sample with a WHERE, or aggregate before joining) rather than re-running the same heavy query. An unknown-column / syntax error means re-read the schema with describeTable — don't guess a second column name. Fix the actual cause; never silently drop the analysis because one query failed.",
  "- When the reader @-mentions a saved DASHBOARD, its tiles are provided to you as context (each tile's title, kind and SQL). Reason about it from that — those queries are the dashboard's source of truth. Re-run or adapt a tile's SQL with queryClickhouse when you need live numbers; do not invent tiles it does not list.",
  "- When the reader @-mentions a WATCHER, its rule, cadence, current status, last reading and SQL are provided as context. Treat that SQL and rule as its source of truth; re-run the SQL with queryClickhouse for a live number, and do not invent watchers or thresholds not listed.",
  "- NEVER ask for a threshold in prose — not the first time, not after the reader changes their mind. EVERY time a metric becomes settled, including when the reader picks a different one later in the conversation, write that metric's scalar SELECT, RUN it so you know what it reads today, and call askThreshold with that number as currentValue. If you are about to type a sentence containing a threshold example, call askThreshold instead. The reader's submitted answer carries the direction, value and cadence; hand them straight to createWatcher.",
  "",
  "Reading the data — the real sequence:",
  "1. listTables to see what exists (skip if you already listed them this conversation).",
  "2. describeTable on each table you intend to query, so every column name and type comes from the live schema.",
  "3. DISCOVER before you assume. A column's name and type rarely tell you what its VALUES mean. When a categorical column drives the question — an enum, an event/type/status/action code, any set of members you would otherwise guess at — sample it first (SELECT DISTINCT, or topK / groupUniqArray for a big one) and read a handful of sample rows, so your SQL keys off what is actually in the data. Recognise the dataset from its schema and bring what you already know about that domain to bear — then VERIFY it against the values rather than trusting a name. (For instance, on a GitHub-events table the members of its event-type column are where stars, forks, pushes, issues and PRs each live — a 'star' is not a column, it is a value; sample the column, confirm which member it is, then key off that.)",
  "4. Write ClickHouse SQL and call queryClickhouse — iterating when it helps: a cheap probe to learn the shape, then the real query.",
  "",
  "Which tool the answer takes — match the request, in this order:",
  "- The answer IS a single headline number (a total, a count, an average, a rate): renderStat with its label + value. A stat can sit alongside charts in an overview.",
  "- The shape of the data is the point and a chart reads better than prose: renderChart with the rows you fetched — pick the chartType from that shape (the tool maps each shape to its chart and lists the channels each needs), don't reflexively reach for a bar, line or pie.",
  "- A broad, open-ended ask ('give me an overview', 'build a dashboard', 'what's interesting about this table') hands YOU the analysis — derive the views yourself, don't wait to be told. FIRST explore cheaply: describeTable, then probe the distinct values of the key categorical columns, the time span, and rough cardinalities, so you know what carries signal. THEN plan the board like a real analyst before you render — decide ~10–14 DISTINCT angles and make them VARIED. A board that is the same `count() … GROUP BY x` repeated across different columns is a FAILURE, however many tiles it has. You MUST span analytical PATTERNS, for example: the trend over time AND its CHANGE (period-over-period / YoY with a window function — lagInFrame); a DISTRIBUTION (bucket a per-entity measure — count per entity in a subquery, then a histogram or quantiles); top-N by the dimensions that matter; a PER-GROUP top-N (the top item within each of the top groups, via row_number/rank); a RATIO or proportion between two measures (e.g. stars-to-forks); a CADENCE (by day-of-week or hour); a CONCENTRATION / cohort cut (what share the top few hold). Reach for the full SQL surface — subqueries, CTEs, window functions, ratios — to get these; flat single-level aggregates alone are not a dashboard. Lead with a few renderStat headline numbers, then this varied spread of renderChart tiles, a distinct title on each. When the reader instead POINTS at a specific metric or cut ('stars over time', 'top repos by forks'), do exactly that, well — the discovery is for when they haven't.",
  "- Render only what you actually got: NEVER call renderChart or renderStat for a query that errored or returned no rows — fix the query and re-run, or drop that tile. NEVER emit a renderChart without both its chartType and its sql; if a call dropped a field, re-issue it complete rather than leaving a broken 'couldn't draw' tile.",
  "- The user asks to be told/alerted WHEN something happens ('tell me when …', 'alert me if …', 'watch …'): createWatcher instead of just answering — SQL that aggregates the metric down to ONE number, plus the threshold askThreshold came back with. Don't create a watcher for a plain one-off question.",
  "- The request is too vague to know which table, metric or dimension it means ('show me the data', 'what's interesting', 'break it down'): presentChoices with the real candidates (listTables first when the choice is a table), instead of guessing or asking in prose.",
  "- You are asked to watch a CHART: its query returns a column of rows while a watcher compares ONE number, so the metric has to be chosen before the SQL exists. Offer the real candidates with presentChoices (the total, the top category's value, the count of categories over a line), then follow the threshold rule above.",
  "- The user wants to change or remove a watcher ('pause my alert', 'change it to daily', 'delete that watcher'): listWatchers when you don't have its id, then editWatcher (change only the fields asked; state 'paused'/'active' pauses/resumes) or deleteWatcher. Only delete when the user clearly asks to.",
  "",
  "How to answer — the UI already shows your steps and renders every tool result as a tile, table, chart, form or card. Text is expensive and the reader skims, so your prose is a caption, not a report:",
  "- Lead with the finding in ONE sentence, then stop. A second sentence is allowed only when it carries a 'so what' the numbers can't show on their own. Three sentences is almost always one too many.",
  "- Cut the scaffolding: no restating the question, no 'Based on the data…' / 'Here's what I found', no narrating steps ('Let me check…', 'Now I'll query…', 'I found…'), no hedging ('it seems', 'roughly', 'you might want to'). The work card already shows every step.",
  "- Don't transcribe or walk through a table or chart. Point at what it shows that the reader would otherwise miss ('spikes on weekends', 'the top three take 80%') and add only the one thing they can't see for themselves. If the tile speaks for itself, add nothing.",
  "- A watcher card, a choice list and a threshold form ARE the answer, not a preview of one. Don't restate their contents or re-ask their question in prose.",
  "- Example — asked 'which payment type is most common?', after the query: say 'Credit cards, at 62% of trips — cash is a distant second.' NOT 'Based on the data I queried, it looks like the most common payment type appears to be credit card, which makes up roughly 62% of all trips, followed by cash…'.",
].join("\n");

/** The text of a ModelMessage, flattening string or multi-part content. */
function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ");
}

/**
 * Inject an @-mentioned dashboard's or watcher's summary into the turn.
 *
 * A table @mention needs nothing here — the token is the whole context and the
 * agent reads the schema itself. A board and a watcher have no such tool: both
 * live in Postgres, not ClickHouse, so their definitions are loaded here
 * (matching the token the composer wrote) and appended to the last user message,
 * right where the reader named them. Appending to that message rather than
 * pushing a new one keeps roles alternating and lets the cache breakpoint still
 * land on the last message. Returns the array untouched when neither is
 * mentioned — the common case pays only a substring check per loader.
 */
async function withMentionContext(
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const userText = messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
  const [boards, watchers] = await Promise.all([
    loadMentionedBoardsContext(userText),
    loadMentionedWatchersContext(userText),
  ]);

  const blocks: string[] = [];
  if (boards) {
    blocks.push(
      `Context — the reader @-mentioned these saved dashboards. Treat each tile's SQL as the source of truth for that dashboard:\n\n${boards}`,
    );
  }
  if (watchers) {
    blocks.push(
      `Context — the reader @-mentioned these watchers (saved threshold monitors). Each watcher's rule and SQL are its source of truth:\n\n${watchers}`,
    );
  }
  if (blocks.length === 0) return messages;

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return messages;

  const target = messages[lastUser]!;
  const block = `\n\n${blocks.join("\n\n")}`;
  const content =
    typeof target.content === "string"
      ? [{ type: "text" as const, text: target.content + block }]
      : [...target.content, { type: "text" as const, text: block }];
  const withContext = { ...target, content } as ModelMessage;
  return messages.map((message, i) => (i === lastUser ? withContext : message));
}

export const clickhouseChat = chat.agent({
  id: "clickhouse-chat",
  // Declared here as well as passed back below, so each tool's toModelOutput
  // survives when history is re-converted on later turns.
  tools,
  // Roll a cache breakpoint onto the LAST message so the whole conversation
  // prefix (not just tools+system) is cached: the next turn reads the prior
  // history back instead of re-processing it. cache.agent runs this on every
  // prompt-building path (each turn + both compaction rebuilds), so the
  // breakpoint always lands on the real last message. Message-level cacheControl
  // attaches to that message's last content part (@ai-sdk/anthropic
  // convert-to-anthropic-prompt: last part falls back to message providerOptions).
  // Composes with the system breakpoint — Anthropic allows up to 4; we use 2.
  prepareMessages: async ({ messages, reason }) => {
    // Inject @-mentioned dashboard/watcher context only on a live turn. The
    // compaction paths rebuild from history whose text already carries any
    // earlier injection, and re-reading Postgres there would be wasted work.
    const prepared =
      reason === "run" ? await withMentionContext(messages) : messages;
    const last = prepared[prepared.length - 1];
    if (!last) return prepared;
    // Spreading a discriminated union widens role/content, so re-assert the
    // ModelMessage type — the shape is unchanged at runtime.
    const withBreakpoint = {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        anthropic: { cacheControl: { type: "ephemeral" as const } },
      },
    } as ModelMessage;
    return [...prepared.slice(0, -1), withBreakpoint];
  },
  // Persist the OPENING turn's user message + a session anchor BEFORE the model
  // starts streaming, so a reader who asks the first question, navigates away
  // during the (often 1–2 min) build, and comes back finds the turn still there
  // and the live stream resumable — rather than a blank chat until onTurnComplete
  // finally fires. Without this, nothing is in Postgres mid-first-run: the route
  // reads back no messages (blank thread) and no session (can't resubscribe).
  //
  // Turn 0 ONLY. Later turns already have a session row carrying a real SSE
  // cursor from the previous onTurnComplete; overwriting it here with a
  // cursorless anchor would force a resubscribe-from-zero that can replay the
  // prior turn's stale turn-complete and close the stream empty. Seeding the
  // user message flips the frontend's `resume` test true (last message is the
  // user's), and the anchor gives the transport a session to reconnect to.
  onTurnStart: async ({ chatId, uiMessages, turn, chatAccessToken }) => {
    if (turn !== 0) return;
    try {
      await saveMessages(chatId, uiMessages, turn);
      await saveSession(chatId, { publicAccessToken: chatAccessToken });
    } catch (err) {
      // Best-effort, exactly like onTurnComplete: the live Session still holds
      // the turn, so the worst case is the pre-compaction blank window we had
      // before — the run must never fail on a DB hiccup.
      console.error("[onTurnStart] pre-persist failed:", err);
    }
  },
  // Persist each turn so a reloaded tab isn't empty. AWAITED inline (not
  // chat.defer'd): a mid-stream refresh must read the turn, not []. We store
  // this turn's messages (user + assistant response) and refresh the session's
  // token + stream cursor so the transport resubscribes to the same Session.
  onTurnComplete: async ({
    chatId,
    newUIMessages,
    turn,
    chatAccessToken,
    lastEventId,
  }) => {
    try {
      await saveMessages(chatId, newUIMessages, turn);
      await saveSession(chatId, {
        publicAccessToken: chatAccessToken,
        lastEventId,
      });
    } catch (err) {
      // Persistence is best-effort: the live Session still holds the turn, so a
      // reload might lose it, but the run must NOT fail on a DB hiccup — a failed
      // run can't continue, which would break every follow-up message.
      console.error("[onTurnComplete] persist failed:", err);
    }
  },
  run: async ({ messages, tools, signal }) => {
    // Register the system prompt with the framework EVERY turn (not just in
    // onChatStart, which fires once per chat) so toStreamTextOptions() rebuilds
    // it on every path. The providerOptions ride along: the SDK emits the system
    // as a SystemModelMessage carrying cache_control, so Anthropic caches the
    // tools+system prefix after step 1 instead of re-billing it each turn. A
    // bare string never gets cache_control — this is the documented path.
    // https://trigger.dev/docs/ai-chat/prompt-caching
    chat.prompt.set(SYSTEM_PROMPT, {
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" as const } },
      },
    });
    return streamText({
      // Spread FIRST: wires the cached system (from chat.prompt.set above),
      // prepareStep (compaction, steering, background injection) and telemetry.
      // Explicit overrides then win.
      ...chat.toStreamTextOptions({ tools }),
      model: anthropic("claude-sonnet-5"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    });
  },
});

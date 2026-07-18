import { ai, chat } from "@trigger.dev/sdk/ai";
import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { clickhouse, READONLY_SETTINGS } from "@/lib/clickhouse/client";
import { describeTable, listTables } from "@/lib/clickhouse/introspect";
import { saveMessages } from "@/lib/db/messages";
import { saveSession } from "@/lib/db/sessions";
import { createWatcherCore } from "@/lib/watchers/create";
import type { WatcherThreshold } from "@/types/db";

const tools = {
  listTables: tool({
    description:
      "List the tables and views available in the configured ClickHouse " +
      "database, with their engine and row count. Call this first when you " +
      "don't yet know what data exists.",
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
      "writing SQL against a table so column names and types are read from the " +
      "live schema rather than guessed.",
    inputSchema: z.object({
      database: z.string().describe("The database the table lives in."),
      table: z.string().describe("The table name, without the database prefix."),
    }),
    execute: async ({ database, table }) => {
      const schema = await describeTable(database, table);
      return schema ?? { error: `No table ${database}.${table}.` };
    },
  }),

  queryClickhouse: tool({
    description:
      "Run a read-only SQL SELECT against the configured ClickHouse database. " +
      "Prefer aggregates over raw rows; always add a LIMIT when selecting rows.",
    inputSchema: z.object({
      sql: z
        .string()
        .describe(
          "A single ClickHouse SELECT statement, qualified with the database " +
            "(db.table). No trailing semicolon, no FORMAT clause.",
        ),
    }),
    execute: async ({ sql }) => {
      const resultSet = await clickhouse.query({
        query: sql,
        format: "JSONEachRow",
        clickhouse_settings: READONLY_SETTINGS,
      });
      return await resultSet.json();
    },
  }),

  renderChart: tool({
    description:
      "Render a chart from rows you already fetched with queryClickhouse, when " +
      "the answer reads better as a chart than prose. Choose chartType by the " +
      "data's JOB (don't default to bars) and map every channel the chart uses " +
      "to a row field in `encodings`. A single number is a stat, not a chart.\n\n" +
      "Channel guide (set only the channels the chart uses):\n" +
      "- Trend over time — Line Chart, Area Chart, Streamgraph, Bump Chart, " +
      "Slope Chart, Range Area Chart(x,y,y2): x=time, y=measure, color=series.\n" +
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
      "itself (e.g. \"Total towers\", \"Avg trip distance\"), not a sentence.",
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
            "'' for a plain number.",
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
      "aggregate it down to a scalar. Confirm the watcher was created in your reply.",
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
            summary: `Watcher created — re-runs ${schedule}, alerts when it ${direction.replace(/_/g, " ")} ${value}${unit ?? ""}.`,
          }
        : { ok: false, error: result.error };
    },
  }),
};

const SYSTEM_PROMPT = [
  "You are a data analyst working over a ClickHouse database.",
  "You do not know the schema in advance — discover it at runtime.",
  "",
  "Workflow:",
  "1. Call listTables to see what exists (skip if you already know it this conversation).",
  "2. Call describeTable on the tables you intend to query, so every column name and type comes from the live schema.",
  "3. Write ClickHouse SQL and call queryClickhouse.",
  "4. When a chart communicates better than prose, call renderChart with the rows you fetched (the tool lists the chart families and the channels each needs). For a broad ask ('give me an overview', 'build a dashboard', 'break this down by X and over time') call it several times in one turn, once per view, each with a distinct title — together they tile into a dashboard the reader can pin to a board in one click.",
  "5. When the answer IS a single headline number (a total, a count, an average, a rate), call renderStat with its label + value. A stat can sit alongside charts in an overview.",
  "6. When the user asks to be told/alerted WHEN something happens ('tell me when …', 'alert me if …', 'watch …'), call createWatcher instead of just answering: write SQL that aggregates the metric down to ONE number, pick a schedule and a threshold, and confirm it in your reply. Don't create a watcher for a plain one-off question.",
  "",
  "Rules:",
  "- Never invent numbers, table names, or columns — every figure you report must come from a tool result, and every identifier from an introspection result.",
  "- Tables may be large, so aggregate in SQL rather than pulling rows into context.",
  "- If a query errors, re-read the schema before retrying.",
  "",
  "How to answer — the UI already shows your steps and renders the query results as tiles, tables and charts. Text is expensive; the reader skims. So:",
  "- Answer in ONE sentence: the finding. Then stop. Add a second sentence only if it carries why-it-matters that the numbers alone don't.",
  "- Never narrate your process. No 'Let me check…', 'Now I'll query…', 'I found…' — the work card already shows every step.",
  "- The tiles/tables/charts already show the numbers — don't transcribe or walk through them. Point at what they show ('spikes on weekends', 'the top three dominate') and add only the one thing the reader can't see for themselves.",
].join("\n");

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
  prepareMessages: async ({ messages }) => {
    const last = messages[messages.length - 1];
    if (!last) return messages;
    // Spreading a discriminated union widens role/content, so re-assert the
    // ModelMessage type — the shape is unchanged at runtime.
    const withBreakpoint = {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        anthropic: { cacheControl: { type: "ephemeral" as const } },
      },
    } as ModelMessage;
    return [...messages.slice(0, -1), withBreakpoint];
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

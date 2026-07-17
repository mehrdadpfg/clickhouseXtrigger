import { chat } from "@trigger.dev/sdk/ai";
import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { clickhouse, READONLY_SETTINGS } from "@/lib/clickhouse/client";
import { describeTable, listTables } from "@/lib/clickhouse/introspect";
import { saveMessages } from "@/lib/db/messages";
import { saveSession } from "@/lib/db/sessions";

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
      "Render a chart from rows you already fetched with queryClickhouse. Call " +
      "AFTER querying, when the answer reads better as a chart than prose. Pass " +
      "the actual rows; the frontend compiles the spec to an ECharts chart. Pick " +
      "chartType by the data's JOB, and don't default to bars — map each channel " +
      "the chart uses to a row field in `encodings`. One chart per answer unless " +
      "asked. A single number is a stat, not a chart.\n\n" +
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
};

export const clickhouseChat = chat.agent({
  id: "clickhouse-chat",
  // Declared here as well as passed back below, so each tool's toModelOutput
  // survives when history is re-converted on later turns.
  tools,
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
  run: async ({ messages, tools, signal }) =>
    streamText({
      // Must be spread FIRST: wires prepareStep (compaction, steering,
      // background injection) and telemetry. Explicit overrides then win.
      ...chat.toStreamTextOptions({ tools }),
      model: anthropic("claude-sonnet-5"),
      system: [
        "You are a data analyst working over a ClickHouse database.",
        "You do not know the schema in advance — discover it at runtime.",
        "",
        "Workflow:",
        "1. Call listTables to see what exists (skip if you already know it this conversation).",
        "2. Call describeTable on the tables you intend to query, so every column name and type comes from the live schema.",
        "3. Write ClickHouse SQL and call queryClickhouse.",
        "4. When the answer reads better as a chart, call renderChart with the rows you fetched. Pick the chartType that fits the data's JOB — the tool lists 30+ types across families (trend, ranking, part-to-whole, relationship, distribution, matrix, indicator, financial, flow) and the channels each needs. Don't default to a bar chart: a proportion is a pie or treemap, a distribution is a histogram or box plot, a correlation is a scatter, a flow is a sankey, a trend is a line. Map each channel to a real column. One chart per answer unless asked. A single number is a stat, not a chart.",
        "",
        "Rules:",
        "- Never invent numbers, table names, or columns — every figure you report must come from a tool result, and every identifier from an introspection result.",
        "- Tables may be large, so aggregate in SQL rather than pulling rows into context.",
        "- If a query errors, re-read the schema before retrying.",
        "",
        "How to answer — the UI already shows your steps and renders the query results as tiles, tables and charts. Text is expensive; the reader skims. So:",
        "- Answer in ONE sentence: the finding. Then stop. Add a second sentence only if it carries why-it-matters that the numbers alone don't.",
        "- Never narrate your process. No 'Let me check…', 'Now I'll query…', 'I found…' — the work card already shows every step.",
        "- Never transcribe numbers that a tile, table or chart already shows. Point at the result ('spikes on weekends', 'the top three dominate'), don't restate the figures.",
        "- When a chart or table already answers the question, a single sentence of framing is enough — do not walk through the rows.",
        "- Prefer showing over telling: render the result, then say the one thing the reader can't see for themselves.",
      ].join("\n"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    }),
});

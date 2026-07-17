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
      "Declare a chart to render from rows you already fetched with " +
      "queryClickhouse. Call this AFTER querying, when the answer reads better " +
      "as a trend, ranking, relationship or distribution than as prose. Pass " +
      "the actual rows — the frontend compiles the spec to a chart. Choose kind " +
      "by the data's job: over-time = line (or area), ranking/categories = bar " +
      "(barH when the category labels are long), relationship = scatter. One " +
      "chart per answer unless asked for more. A single number is a stat, not a " +
      "chart — leave it to the table/stat path.",
    inputSchema: z.object({
      kind: z
        .enum(["line", "bar", "barH", "scatter", "area"])
        .describe(
          "line/area = over time; bar = ranking or categories; barH = same " +
            "with long labels; scatter = relationship between two fields.",
        ),
      title: z.string().describe("Short chart title."),
      x: z.object({
        field: z.string().describe("Row key for the x axis (categories or time)."),
        label: z.string().optional().describe("Axis label; defaults to the field."),
      }),
      y: z.object({
        field: z.string().describe("Row key for the y axis (the measure)."),
        label: z.string().optional().describe("Axis label; defaults to the field."),
      }),
      series: z
        .object({
          field: z.string().describe("Row key to split into multiple series."),
        })
        .optional()
        .describe("Omit for a single series."),
      data: z
        .array(z.record(z.string(), z.unknown()))
        .describe("The rows fetched from queryClickhouse, passed through as-is."),
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
    await saveMessages(chatId, newUIMessages, turn);
    await saveSession(chatId, {
      publicAccessToken: chatAccessToken,
      lastEventId,
    });
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
        "4. When the answer is a trend, ranking, relationship or distribution, call renderChart with the rows you just fetched (line/area = over time, bar = ranking/categories, barH = long labels, scatter = relationship). One chart per answer unless asked for more. A single number is a stat, not a chart — leave it to the table.",
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

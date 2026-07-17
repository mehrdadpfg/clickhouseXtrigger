import { chat } from "@trigger.dev/sdk/ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@clickhouse/client";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

// One client per worker process — createClient opens a connection pool,
// so it must not be created per request.
const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL,
});

const NYC_TAXI_SCHEMA = `
default.nyc_taxi (20M rows, SharedMergeTree, ORDER BY (pickup_datetime, dropoff_datetime))
  trip_id            UInt32
  pickup_datetime    DateTime
  dropoff_datetime   DateTime
  pickup_longitude   Nullable(Float64)
  pickup_latitude    Nullable(Float64)
  dropoff_longitude  Nullable(Float64)
  dropoff_latitude   Nullable(Float64)
  passenger_count    Nullable(UInt8)
  trip_distance      Nullable(Float32)
  fare_amount        Float32
  extra              Float32
  tip_amount         Float32
  tolls_amount       Float32
  total_amount       Float32
  payment_type       Enum8('CSH'=1,'CRE'=2,'NOC'=3,'DIS'=4,'UNK'=5)
  pickup_ntaname     LowCardinality(String)   -- pickup neighbourhood
  dropoff_ntaname    LowCardinality(String)   -- dropoff neighbourhood
`.trim();

const tools = {
  queryClickhouse: tool({
    description:
      "Run a read-only ClickHouse SQL SELECT against the NYC taxi trips table. " +
      "Use this for any question about trips, fares, tips, payment types, or neighbourhoods. " +
      "Prefer aggregates over raw rows; always add a LIMIT when selecting rows.",
    inputSchema: z.object({
      sql: z
        .string()
        .describe(
          "A single ClickHouse SELECT statement against default.nyc_taxi. No trailing semicolon, no FORMAT clause.",
        ),
    }),
    execute: async ({ sql }) => {
      const resultSet = await clickhouse.query({
        query: sql,
        format: "JSONEachRow",
        clickhouse_settings: {
          // readonly=2 permits SELECTs and lets us set the guards below.
          // (readonly=1 would reject the settings themselves.)
          readonly: "2",
          max_execution_time: 30,
          // Truncate instead of erroring when a query returns too much.
          max_result_rows: "500",
          result_overflow_mode: "break",
        },
      });
      return await resultSet.json();
    },
  }),
};

export const clickhouseChat = chat.agent({
  id: "clickhouse-chat",
  // Declared here as well as passed back below, so each tool's toModelOutput
  // survives when history is re-converted on later turns.
  tools,
  run: async ({ messages, tools, signal }) =>
    streamText({
      // Must be spread FIRST: wires prepareStep (compaction, steering,
      // background injection) and telemetry. Explicit overrides then win.
      ...chat.toStreamTextOptions({ tools }),
      model: anthropic("claude-sonnet-5"),
      system: [
        "You are a data analyst for a NYC taxi trips dataset in ClickHouse.",
        "Answer questions by writing ClickHouse SQL and calling the queryClickhouse tool.",
        "Never invent numbers — every figure you report must come from a tool result.",
        "The table is large, so aggregate in SQL rather than pulling rows into context.",
        "",
        "Schema:",
        NYC_TAXI_SCHEMA,
      ].join("\n"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    }),
});

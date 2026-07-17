/**
 * Turning a tool call into a sentence about what the agent is doing.
 *
 * The tool *names* are the agent's contract (src/trigger/chat.ts) and are
 * domain knowledge, which is why this lives under components/chat and not
 * components/ui. What the tools are pointed *at* is not known here: the detail
 * line is read off the call's own arguments, so a describeTable step reads
 * "sales.orders" or "logs.events" depending only on what the agent asked for.
 */

/** Matches the tool ids declared on chat.agent({ tools }). */
export const LIST_TABLES = "listTables";
export const DESCRIBE_TABLE = "describeTable";
export const QUERY_CLICKHOUSE = "queryClickhouse";
export const RENDER_CHART = "renderChart";

export interface StepCopy {
  /** The step, as a phrase: "Reading schema". */
  label: string;
  /** What it is acting on: "sales.orders". Absent until the args stream in. */
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or nothing. Args arrive as a partial parse while streaming. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** First line of the SQL, for the step's one-line detail. */
function firstLine(sql: string): string {
  const line = sql.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/**
 * @param running Whether the call is still in flight — the label is a
 *   participle either way, but the tense differs.
 */
export function stepCopy(
  toolName: string,
  args: unknown,
  running: boolean,
): StepCopy {
  const a = isRecord(args) ? args : {};

  switch (toolName) {
    case LIST_TABLES: {
      const database = str(a["database"]);
      return {
        label: running ? "Listing tables" : "Read the table list",
        detail: database,
      };
    }

    case DESCRIBE_TABLE: {
      const database = str(a["database"]);
      const table = str(a["table"]);
      return {
        label: running ? "Reading schema" : "Read schema",
        detail: database && table ? `${database}.${table}` : table,
      };
    }

    case QUERY_CLICKHOUSE: {
      const sql = str(a["sql"]);
      return {
        label: running ? "Running query" : "Ran query",
        detail: sql ? firstLine(sql) : undefined,
      };
    }

    case RENDER_CHART: {
      return {
        label: running ? "Drawing chart" : "Drew chart",
        detail: str(a["title"]),
      };
    }

    // An unknown tool is still worth naming: better a real tool id than a
    // spinner that says nothing.
    default:
      return { label: running ? `Calling ${toolName}` : `Called ${toolName}` };
  }
}

/** The card's header while the agent works — the phase it is currently in. */
export function phaseLabel(toolName: string, args: unknown): string {
  const { label, detail } = stepCopy(toolName, args, true);
  return detail ? `${label} · ${detail}` : label;
}

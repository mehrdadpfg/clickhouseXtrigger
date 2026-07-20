"use client";

import { Fragment, useMemo } from "react";
import { format } from "sql-formatter";
import styles from "./SqlCode.module.css";

/**
 * Read-only ClickHouse SQL with syntax colour — the query under a chart.
 *
 * Hand-tokenised on purpose. @codemirror/lang-sql ships dialects for Postgres,
 * MySQL, MariaSQL, MSSQL, SQLite, Cassandra and PLSQL — but NOT ClickHouse, so
 * a full editor dependency would still need these word lists supplied by hand
 * while adding an editor's weight to a box nobody types in.
 *
 * It colours, it does not parse: an exotic query degrades to plain text rather
 * than mis-rendering. The pieces that matter for ClickHouse specifically are
 * its own clauses (PREWHERE, FINAL, ARRAY JOIN, LIMIT BY, SETTINGS), its type
 * names (which read as identifiers to a generic SQL grammar), backtick-quoted
 * identifiers, and `::` casts. Function names need no list — any identifier
 * followed by "(" is one, which covers toStartOfHour and uniqExactIf alike.
 */

/**
 * Longest alternative first inside each group: `ORDER BY` must win over
 * `ORDER`, and `DateTime64` over `DateTime`.
 */
const KEYWORDS = [
  // Multi-word clauses first.
  "GROUP BY", "ORDER BY", "PARTITION BY", "LIMIT BY", "ARRAY JOIN", "LEFT ARRAY JOIN",
  "WITH FILL", "WITH TIES", "WITH TOTALS", "WITH CUBE", "WITH ROLLUP",
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "ASOF JOIN",
  "SEMI JOIN", "ANTI JOIN", "ANY JOIN", "UNION ALL", "UNION DISTINCT",
  "IS NOT NULL", "IS NULL", "NOT IN", "GLOBAL IN", "ORDER BY ALL",
  "PASTE JOIN", "CURRENT ROW", "NULLS FIRST", "NULLS LAST",
  "RESPECT NULLS", "IGNORE NULLS",
  // Single words.
  "SELECT", "FROM", "PREWHERE", "WHERE", "HAVING", "LIMIT", "OFFSET", "JOIN", "ON",
  "USING", "AS", "AND", "OR", "NOT", "IN", "WITH", "CASE", "WHEN", "THEN", "ELSE",
  "END", "DESC", "ASC", "DISTINCT", "BETWEEN", "LIKE", "ILIKE", "UNION", "EXCEPT",
  "INTERSECT", "ALL", "ANY", "SETTINGS", "FORMAT", "INTERVAL", "FINAL", "SAMPLE",
  "GLOBAL", "APPLY", "EXCLUDE", "REPLACE", "TTL", "ENGINE", "CAST", "EXTRACT",
  "NULL", "TRUE", "FALSE", "INF", "NAN",
  // Window clauses and the remaining ClickHouse join strengths, cross-checked
  // against sql-formatter's ClickHouse keyword list (generated from ClickHouse's
  // own keywords.dict). Its full 397 are NOT vendored: that list serves a
  // formatter that must recognise DDL too, so it includes NAME, TYPE, SOURCE,
  // KEY, TIME, STATUS — words far likelier to be columns than keywords in the
  // analytical SELECTs this box shows, which would colour them wrongly.
  "OVER", "WINDOW", "PRECEDING", "FOLLOWING", "UNBOUNDED", "ROWS", "RANGE",
  "QUALIFY", "ASOF", "SEMI", "ANTI", "OUTER", "EXISTS", "VALUES", "RECURSIVE",
  "LATERAL", "ASCENDING", "DESCENDING", "IS",
];

const TYPES = [
  "UInt256", "UInt128", "UInt64", "UInt32", "UInt16", "UInt8",
  "Int256", "Int128", "Int64", "Int32", "Int16", "Int8",
  "Float64", "Float32", "Decimal256", "Decimal128", "Decimal64", "Decimal32", "Decimal",
  "DateTime64", "DateTime", "Date32", "Date", "Time64", "Time",
  "FixedString", "String", "UUID", "IPv4", "IPv6", "Bool",
  "LowCardinality", "Nullable", "Array", "Map", "Tuple", "Nested", "Variant", "Dynamic",
  "Enum16", "Enum8", "Enum", "JSON", "AggregateFunction", "SimpleAggregateFunction",
];

const TOKEN = new RegExp(
  [
    "(--[^\\n]*|/\\*[\\s\\S]*?\\*/)", // 1 comment
    "('(?:[^'\\\\]|\\\\.|'')*'|`[^`]*`|\"[^\"]*\")", // 2 string / quoted identifier
    `\\b(${KEYWORDS.join("|")})\\b`, // 3 keyword
    `\\b(${TYPES.join("|")})\\b`, // 4 type
    "(0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)", // 5 number
    "([A-Za-z_][A-Za-z0-9_]*)(?=\\s*\\()", // 6 function call
    "(::|->|=>)", // 7 cast / lambda
  ].join("|"),
  // Case-insensitive so `select` colours like `SELECT` — SQL is written both
  // ways. Types are re-checked case-SENSITIVELY below, because ClickHouse type
  // names are (`String`, not `STRING`) and a column called `date` must not
  // colour as the Date type.
  "gi",
);

const EXACT_TYPES = new Set(TYPES);

type Piece = { text: string; kind: string | null };

function tokenize(sql: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;

  for (const m of sql.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    const whole = m[0] ?? "";
    if (at > last) out.push({ text: sql.slice(last, at), kind: null });

    let kind: string | null;
    if (m[1]) kind = "comment";
    else if (m[2]) kind = m[2].startsWith("'") ? "string" : "ident";
    else if (m[3]) kind = "keyword";
    // Only an exact-case spelling is the type, and a near-miss is a plain
    // identifier, not a styled one: a column called `date` is not `Date`.
    else if (m[4]) kind = EXACT_TYPES.has(m[4]) ? "type" : null;
    else if (m[5]) kind = "number";
    else if (m[6]) kind = "fn";
    else kind = "op";

    out.push({ text: whole, kind });
    last = at + whole.length;
  }

  if (last < sql.length) out.push({ text: sql.slice(last), kind: null });
  return out;
}

/**
 * Lay the query out before colouring it. The agent often writes a whole query
 * on one line, which reads as a wall in a fixed-width box.
 *
 * sql-formatter DOES have a real ClickHouse dialect (its keyword list is
 * generated from ClickHouse's own keywords.dict), which is why it earns a place
 * here even though its highlighting story is nil — formatting is what it is for.
 * It throws on syntax it can't parse, and a query we can't format is still one
 * worth showing, so a failure falls back to the original text.
 */
function prettify(sql: string): string {
  try {
    return format(sql, { language: "clickhouse", keywordCase: "upper" });
  } catch {
    return sql.trim();
  }
}

export function SqlCode({ sql }: { sql: string }) {
  const pieces = useMemo(() => tokenize(prettify(sql)), [sql]);

  return (
    <pre className={styles.code}>
      <code>
        {pieces.map((p, i) => (
          <Fragment key={i}>
            {p.kind ? <span className={styles[p.kind]}>{p.text}</span> : p.text}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

/** Exported for the tokenizer's test — the word lists are easy to get wrong. */
export const __test = { tokenize };

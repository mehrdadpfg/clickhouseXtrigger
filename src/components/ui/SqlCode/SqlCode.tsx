"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, SQLDialect } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { format } from "sql-formatter";
import {
  CLICKHOUSE_FUNCTIONS,
  CLICKHOUSE_KEYWORDS,
  CLICKHOUSE_TYPES,
} from "./clickhouse-words";

/**
 * A ClickHouse SQL box — read-only under a chart, or editable in the workspace.
 *
 * CodeMirror does the editing and the highlighting, which replaced a
 * hand-rolled tokenizer and a transparent-textarea-over-a-pre overlay. The
 * overlay worked, but it only stays aligned while both layers agree on font,
 * size, line-height, padding and wrapping to the pixel — a standing trap for
 * whoever next touched the CSS.
 *
 * @codemirror/lang-sql ships no ClickHouse dialect (only Postgres, MySQL,
 * MariaSQL, MSSQL, SQLite, Cassandra, PLSQL), but SQLDialect.define takes word
 * lists — so this is a real one: ClickHouse's own keywords, its type names, and
 * ~1700 of its functions. See ./clickhouse-words for where those come from.
 *
 * Backticks quote identifiers, and ClickHouse has neither `#` comments nor
 * $$-quoting, so both are off.
 */
const ClickHouse = SQLDialect.define({
  keywords: CLICKHOUSE_KEYWORDS,
  types: CLICKHOUSE_TYPES,
  builtin: CLICKHOUSE_FUNCTIONS,
  identifierQuotes: "`",
  backslashEscapes: true,
  hashComments: false,
  slashComments: true,
  doubleDollarQuotedStrings: false,
  doubleQuotedStrings: false,
});

/**
 * Onyx, as a CodeMirror theme. Every colour is a var off :root, so the box
 * tracks the app's tokens instead of carrying a second palette.
 */
const onyx = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg)",
      color: "var(--text-secondary)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-lg)",
      overflow: "hidden",
    },
    "&.cm-focused": {
      outline: "2px solid var(--accent)",
      outlineOffset: "-1px",
    },
    ".cm-content": {
      padding: "12px 4px",
      caretColor: "var(--text)",
      fontFamily: "var(--font-mono)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      lineHeight: "1.65",
    },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
    // The completion popup is portalled outside the editor, so it needs its own
    // surface or it renders on CodeMirror's white default.
    ".cm-tooltip": {
      backgroundColor: "var(--raised)",
      border: "1px solid var(--border-strong)",
      borderRadius: "var(--r-md)",
      color: "var(--text-secondary)",
      boxShadow: "0 10px 26px rgba(0,0,0,0.55)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      fontSize: "11.5px",
      maxHeight: "160px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
      color: "var(--text)",
    },
    ".cm-completionMatchedText": {
      color: "var(--accent)",
      textDecoration: "none",
      fontWeight: "600",
    },
  },
  { dark: true },
);

/**
 * Syntax colours. CodeMirror's default highlight style is built for a light
 * editor — it renders keywords purple and numbers green, which clash badly on
 * the Onyx surface — so the tags lang-sql actually emits are mapped onto the
 * series ramp the charts above are already drawn in.
 *
 * `standard(name)` is where lang-sql puts a `builtin` word, which is what makes
 * ClickHouse's ~1700 function names colour at all.
 */
const onyxHighlight = HighlightStyle.define(
  [
    { tag: tags.keyword, color: "var(--series-1)", fontWeight: "600" },
    { tag: tags.standard(tags.name), color: "var(--series-3)" },
    { tag: tags.typeName, color: "var(--series-5)" },
    { tag: tags.string, color: "var(--series-2)" },
    { tag: tags.special(tags.string), color: "var(--series-2)" },
    { tag: tags.number, color: "var(--series-4)" },
    { tag: [tags.bool, tags.null], color: "var(--series-4)" },
    { tag: [tags.lineComment, tags.blockComment], color: "var(--text-faint)", fontStyle: "italic" },
    { tag: tags.operator, color: "var(--text-muted)" },
    { tag: [tags.paren, tags.brace, tags.squareBracket, tags.punctuation], color: "var(--text-muted)" },
    { tag: tags.name, color: "var(--text-secondary)" },
    { tag: tags.special(tags.name), color: "var(--text)" },
  ],
  { themeType: "dark" },
);

/**
 * Lay the query out before showing it — the agent often writes one long line.
 *
 * sql-formatter's ClickHouse dialect handles FINAL / PREWHERE / LIMIT BY /
 * SETTINGS. It throws on syntax it can't parse, and a query we can't format is
 * still worth showing, so a failure falls back to the original text.
 */
export function prettify(sqlText: string): string {
  try {
    return format(sqlText, { language: "clickhouse", keywordCase: "upper" });
  } catch {
    return sqlText.trim();
  }
}

export function SqlCode({
  value,
  onChange,
  onRun,
  editable = false,
}: {
  value: string;
  onChange?: (next: string) => void;
  /** Cmd/Ctrl+Enter, the shortcut every SQL console has. Plain Enter is a newline. */
  onRun?: () => void;
  editable?: boolean;
}) {
  const extensions = useMemo(() => {
    const base = [
      sql({ dialect: ClickHouse, upperCaseKeywords: false }),
      onyx,
      syntaxHighlighting(onyxHighlight),
      // A query is often one long line; wrapping keeps it readable in a box
      // that is only ~700px wide, rather than scrolling sideways.
      EditorView.lineWrapping,
    ];
    if (!onRun) return base;
    return [
      ...base,
      EditorView.domEventHandlers({
        keydown: (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onRun();
            return true;
          }
          return false;
        },
      }),
    ];
  }, [onRun]);

  return (
    <CodeMirror
      value={value}
      // "none", NOT the default: @uiw/react-codemirror applies theme="light"
      // unless told otherwise, and that white background outranks the onyx
      // extension below — the editor rendered white-on-grey until this was set.
      theme="none"
      editable={editable}
      readOnly={!editable}
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: editable,
        tabSize: 2,
      }}
      {...(onChange ? { onChange } : {})}
    />
  );
}

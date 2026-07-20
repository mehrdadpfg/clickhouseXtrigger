/**
 * The ClickHouse optimization rulebook Tune reasons with.
 *
 * Distilled from the `clickhouse-best-practices` skill (ClickHouse Inc,
 * Apache-2.0) that ships in `.claude/skills/`. Each entry keeps the skill's own
 * rule id and impact level, so a finding can cite `schema-types-lowcardinality`
 * and a reader can go read that exact rule file.
 *
 * WHY THIS IS DATA AND NOT PROSE IN A PROMPT
 * ------------------------------------------
 * Two consumers need the same list and must not drift: the prompt (which tells
 * the model what to look for) and the executor (which decides whether a finding
 * may run DDL at all). Deriving both from one table means a rule cannot be
 * describable-but-unexecutable, or worse, executable but undescribed.
 *
 * THE APPLICABILITY SPLIT IS THE LOAD-BEARING PART
 * ------------------------------------------------
 * Most real ClickHouse optimizations are NOT in-place ALTERs. `applies`
 * separates the ones we may generate DDL for from the ones that need a table
 * rebuild or a change outside the database. It was established empirically
 * against ClickHouse 26.2.1, not from documentation — see ORDER_BY_IS_IMMUTABLE
 * below, which is stricter than the usual "you can append to ORDER BY" advice.
 *
 * Server-only: never import from a "use client" module.
 */

/** The skill's own priority ladder — also how findings are ranked for display. */
export type Impact = "CRITICAL" | "HIGH" | "MEDIUM";

/**
 * Whether a finding of this kind may be turned into DDL Tune will execute.
 *
 * - `ddl`      — a safe, in-place ALTER/CREATE. Gets an Approve button.
 * - `mutation` — in-place, but rewrites every part in the background. Allowed,
 *                but the card must say so: on a multi-GB column this is hours
 *                of merge work, not an instant metadata change.
 * - `rebuild`  — physically impossible in place. The table must be recreated and
 *                backfilled. Advisory only; Tune shows the migration, never runs it.
 * - `external` — not a schema change at all (client batching, query text).
 *                Advisory only.
 */
export type Applicability = "ddl" | "mutation" | "rebuild" | "external";

export type OptimizationKind =
  // --- appliable ---
  | "materialized_view"
  | "projection"
  | "skip_index"
  | "column_type"
  | "column_codec"
  | "ttl"
  // --- advisory ---
  | "order_by"
  | "partitioning"
  | "engine"
  | "denormalize"
  | "ingestion"
  | "query_rewrite";

export type Rule = {
  /** The skill's rule id, cited verbatim in findings. */
  id: string;
  impact: Impact;
  /** The rule's own one-line impact statement. */
  statement: string;
  /** What in the evidence indicates this rule is being violated. */
  signal: string;
};

export type KindSpec = {
  kind: OptimizationKind;
  applies: Applicability;
  /** How the card labels it. */
  label: string;
  /** The DDL shape, for kinds that have one. Empty for advisory kinds. */
  ddl: string[];
  rules: Rule[];
};

/**
 * Verified on ClickHouse 26.2.1 (ClickHouse Cloud, SharedMergeTree):
 *
 *   ALTER TABLE t MODIFY ORDER BY (b, a)   -- existing prefix reordered
 *   → Code 36: Primary key must be a prefix of the sorting key
 *
 *   ALTER TABLE t MODIFY ORDER BY (a, b, c)  -- c already exists on the table
 *   → Code 36: Existing column c is used in the expression that was added to
 *              the sorting key. You can add expressions that use only the
 *              newly added columns.
 *
 * So the common belief that ORDER BY can be *appended to* is only true for
 * columns added in the same breath — useless for fixing an existing key. Both
 * ORDER BY and PARTITION BY are, in practice, immutable after creation.
 */
export const ORDER_BY_IS_IMMUTABLE = true;

export const KINDS: KindSpec[] = [
  {
    kind: "materialized_view",
    applies: "ddl",
    label: "Materialized view",
    ddl: ["CREATE MATERIALIZED VIEW … TO … AS SELECT …"],
    rules: [
      {
        id: "query-mv-incremental",
        impact: "HIGH",
        statement:
          "Read thousands of rows instead of billions; minimal cluster overhead.",
        signal:
          "A recurring aggregation over a large table whose GROUP BY keys are stable.",
      },
      {
        id: "query-mv-refreshable",
        impact: "HIGH",
        statement:
          "Sub-millisecond queries with periodic refresh; ideal for complex joins.",
        signal:
          "A recurring pattern that joins, where an incremental MV cannot express it.",
      },
    ],
  },
  {
    kind: "projection",
    applies: "ddl",
    label: "Projection",
    ddl: [
      "ALTER TABLE … ADD PROJECTION …",
      "ALTER TABLE … MATERIALIZE PROJECTION …",
    ],
    rules: [
      {
        id: "schema-pk-filter-on-orderby",
        impact: "CRITICAL",
        statement: "Skipping prefix columns prevents index usage.",
        signal:
          "A hot pattern filters or orders on columns the table's ORDER BY does not lead with, and ORDER BY cannot be changed.",
      },
    ],
  },
  {
    kind: "skip_index",
    applies: "ddl",
    label: "Skip index",
    // ADD alone is inert: verified that secondary_indices_uncompressed_bytes
    // stays 0 on existing parts until MATERIALIZE runs. Both statements always.
    ddl: [
      "ALTER TABLE … ADD INDEX … TYPE … GRANULARITY …",
      "ALTER TABLE … MATERIALIZE INDEX …",
    ],
    rules: [
      {
        id: "query-index-skipping-indices",
        impact: "HIGH",
        statement: "Up to 60x faster queries by skipping irrelevant granules.",
        signal:
          "A hot pattern filters on a high-cardinality column that is not in ORDER BY, and the filter is selective.",
      },
    ],
  },
  {
    kind: "column_type",
    applies: "mutation",
    label: "Column type",
    ddl: ["ALTER TABLE … MODIFY COLUMN … <type>"],
    rules: [
      {
        id: "schema-types-native-types",
        impact: "CRITICAL",
        statement:
          "2-10x storage reduction; enables compression and correct semantics.",
        signal:
          "A column typed String whose values are numeric, dates, IPs or UUIDs — visible as a numeric-looking name or an implausible compression ratio.",
      },
      {
        id: "schema-types-lowcardinality",
        impact: "HIGH",
        statement:
          "Dictionary encoding for <10K unique values; significant storage reduction.",
        signal:
          "A String column with high compression ratio and few distinct values (confirm with uniq() before proposing).",
      },
      {
        id: "schema-types-minimize-bitwidth",
        impact: "HIGH",
        statement: "Smaller types reduce storage and improve cache efficiency.",
        signal:
          "An Int64/Float64 whose observed min/max fits comfortably in a narrower type.",
      },
      {
        id: "schema-types-avoid-nullable",
        impact: "HIGH",
        statement: "Nullable adds storage overhead; use DEFAULT values instead.",
        signal: "A Nullable column that never actually holds NULL.",
      },
      {
        id: "schema-types-enum",
        impact: "MEDIUM",
        statement:
          "Insert-time validation and natural ordering; 1-2 bytes storage.",
        signal: "A String column with a small, closed, stable value set.",
      },
    ],
  },
  {
    kind: "column_codec",
    applies: "mutation",
    label: "Codec",
    ddl: ["ALTER TABLE … MODIFY COLUMN … CODEC(…)"],
    rules: [
      {
        id: "schema-types-native-types",
        impact: "MEDIUM",
        statement: "Better compression for the column's actual shape.",
        signal:
          "A large column with a poor compression ratio whose values are monotonic (Delta/DoubleDelta) or repetitive (ZSTD at a higher level).",
      },
    ],
  },
  {
    kind: "ttl",
    applies: "ddl",
    label: "TTL",
    ddl: ["ALTER TABLE … MODIFY TTL …"],
    rules: [
      {
        id: "schema-partition-lifecycle",
        impact: "HIGH",
        statement:
          "DROP PARTITION is instant; DELETE is expensive row-by-row scan.",
        signal:
          "A large table with an obvious retention horizon and no TTL, where old data is never queried.",
      },
    ],
  },

  // ---------------- advisory ----------------

  {
    kind: "order_by",
    applies: "rebuild",
    label: "Sort key",
    ddl: [],
    rules: [
      {
        id: "schema-pk-plan-before-creation",
        impact: "CRITICAL",
        statement:
          "ORDER BY is immutable; wrong choice requires full data migration.",
        signal: "Any ORDER BY problem at all — the fix is always a rebuild.",
      },
      {
        id: "schema-pk-cardinality-order",
        impact: "CRITICAL",
        statement:
          "Enables granule skipping; high-cardinality first prevents index pruning.",
        signal:
          "The leading ORDER BY column has very high cardinality relative to the ones after it.",
      },
      {
        id: "schema-pk-prioritize-filters",
        impact: "CRITICAL",
        statement: "Columns not in ORDER BY cause full table scans.",
        signal:
          "The columns hot patterns filter on do not appear in ORDER BY at all.",
      },
      {
        id: "schema-pk-filter-on-orderby",
        impact: "CRITICAL",
        statement: "Skipping prefix columns prevents index usage.",
        signal:
          "Hot patterns filter on a later ORDER BY column while skipping the prefix.",
      },
    ],
  },
  {
    kind: "partitioning",
    applies: "rebuild",
    label: "Partitioning",
    ddl: [],
    rules: [
      {
        id: "schema-partition-low-cardinality",
        impact: "HIGH",
        statement:
          "Too many partitions cause part explosion and 'too many parts' errors.",
        signal:
          "Part count is high relative to row count, or the partition key is finer than monthly on a modest table.",
      },
      {
        id: "schema-partition-start-without",
        impact: "MEDIUM",
        statement:
          "Add partitioning later when you have clear lifecycle requirements.",
        signal: "A partition key that serves no retention or deletion purpose.",
      },
      {
        id: "schema-partition-query-tradeoffs",
        impact: "MEDIUM",
        statement:
          "Partition pruning helps some queries; spanning many partitions hurts others.",
        signal: "Hot patterns routinely span most partitions.",
      },
    ],
  },
  {
    kind: "engine",
    applies: "rebuild",
    label: "Engine",
    ddl: [],
    rules: [
      {
        id: "insert-mutation-avoid-update",
        impact: "CRITICAL",
        statement: "Use lightweight UPDATE or ReplacingMergeTree instead.",
        signal: "ALTER TABLE … UPDATE appears in the query log.",
      },
      {
        id: "insert-mutation-avoid-delete",
        impact: "CRITICAL",
        statement:
          "Use lightweight DELETE, CollapsingMergeTree, or DROP PARTITION instead.",
        signal: "ALTER TABLE … DELETE appears in the query log.",
      },
    ],
  },
  {
    kind: "denormalize",
    applies: "rebuild",
    label: "Join strategy",
    ddl: [],
    rules: [
      {
        id: "query-join-consider-alternatives",
        impact: "CRITICAL",
        statement:
          "Dictionaries and denormalization shift work from query time to insert time.",
        signal:
          "A hot pattern repeatedly joins the same small lookup table — a dictionary would serve it.",
      },
    ],
  },
  {
    kind: "ingestion",
    applies: "external",
    label: "Ingestion",
    ddl: [],
    rules: [
      {
        id: "insert-batch-size",
        impact: "CRITICAL",
        statement:
          "Each INSERT creates a part; single-row inserts overwhelm merge process.",
        signal:
          "Many active parts with a low average row count per part — small writes outrunning merges.",
      },
      {
        id: "insert-async-small-batches",
        impact: "HIGH",
        statement: "Server-side buffering when client batching isn't practical.",
        signal: "Frequent small inserts that the writer cannot easily batch.",
      },
      {
        id: "insert-optimize-avoid-final",
        impact: "HIGH",
        statement:
          "Forces expensive merge of all parts; let background merges work.",
        signal: "OPTIMIZE TABLE … FINAL appears in the query log.",
      },
    ],
  },
  {
    kind: "query_rewrite",
    applies: "external",
    label: "Query shape",
    ddl: [],
    rules: [
      {
        id: "query-join-filter-before",
        impact: "CRITICAL",
        statement: "Joining full tables then filtering wastes resources.",
        signal: "A hot pattern joins first and filters in the outer query.",
      },
      {
        id: "query-join-choose-algorithm",
        impact: "CRITICAL",
        statement:
          "Wrong algorithm causes OOM; right algorithm handles large tables efficiently.",
        signal: "A large join with no join_algorithm setting.",
      },
      {
        id: "query-join-use-any",
        impact: "HIGH",
        statement: "Returns first match only; less memory and faster execution.",
        signal: "A join that only needs one match per key.",
      },
      {
        id: "query-join-null-handling",
        impact: "MEDIUM",
        statement: "Default values instead of NULL reduces memory overhead.",
        signal: "An outer join relying on NULLs where a default would do.",
      },
    ],
  },
];

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));

export function kindSpec(kind: OptimizationKind): KindSpec | undefined {
  return BY_KIND.get(kind);
}

/** Can a finding of this kind ever produce DDL that Tune executes? */
export function isAppliable(kind: OptimizationKind): boolean {
  const spec = BY_KIND.get(kind);
  return spec ? spec.applies === "ddl" || spec.applies === "mutation" : false;
}

export const IMPACT_ORDER: Record<Impact, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
};

/**
 * The rulebook rendered for the model. Generated rather than hand-written so it
 * can never disagree with what `isAppliable` will permit at execution time.
 */
export function renderRulebook(): string {
  const section = (applies: Applicability[], heading: string) => {
    const kinds = KINDS.filter((k) => applies.includes(k.applies));
    return [
      heading,
      ...kinds.map((k) => {
        const rules = k.rules
          .map((r) => `      - ${r.id} [${r.impact}] ${r.statement} SIGNAL: ${r.signal}`)
          .join("\n");
        const ddl = k.ddl.length
          ? `\n    DDL: ${k.ddl.join("  THEN  ")}`
          : "";
        return `  kind: ${k.kind} (${k.label})${ddl}\n${rules}`;
      }),
    ].join("\n");
  };

  return [
    section(
      ["ddl"],
      "APPLIABLE — safe in-place DDL. Emit `statements`; the reader approves and Tune runs them.",
    ),
    "",
    section(
      ["mutation"],
      "APPLIABLE BUT HEAVY — an in-place ALTER that rewrites every part in the background.\nEmit `statements`, and say so in `caveat` when the column is large.",
    ),
    "",
    section(
      ["rebuild", "external"],
      "ADVISORY ONLY — cannot be applied in place. Emit NO statements. Put the migration\nor the change the caller must make in `migration` instead.",
    ),
  ].join("\n");
}

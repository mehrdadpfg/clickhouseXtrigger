/**
 * A minimal line-level diff — enough to render a git-style "changed lines only"
 * view of a rewritten SQL string, with no dependency.
 *
 * It is a classic longest-common-subsequence over LINES: lines present in both
 * old and new are `context`, lines only in old are `del`, lines only in new are
 * `add`. The board's optimize panel renders the `del`/`add` lines (the changes)
 * and drops the context, which is exactly the "only diff lines" a reader wants
 * when a tile's query is repointed at a materialized view.
 *
 * LCS is O(n·m) in lines; a tile's SQL is a handful of lines, so this is never a
 * cost. Kept deliberately tiny rather than pulling in a diff library.
 */
export type DiffLine = { type: "context" | "add" | "del"; text: string };

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  // Walk the table, emitting the same order the two strings read in.
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

/** True when a diff actually changed something (has an add or a del line). */
export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.type !== "context");
}

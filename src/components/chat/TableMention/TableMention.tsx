"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useComposerRuntime } from "@assistant-ui/react";
import { getSchemaNamespace } from "@/app/chats/actions";
import styles from "./TableMention.module.css";

/**
 * Type `@` in the composer to pick a table.
 *
 * The reader knows what they want to ask about long before they know what it is
 * called — "the taxi one", "the arrests table". Without this the only way to
 * find out is to ask the agent to list tables and wait a turn for the answer,
 * which spends a round trip on something the browser can already know.
 *
 * The schema comes from the same `getSchemaNamespace` the SQL editor's
 * autocomplete uses, so the two can never disagree about what exists, and it is
 * fetched once per mount rather than per keystroke.
 *
 * WHY IT WRITES THROUGH THE RUNTIME AND NOT THE TEXTAREA
 * -----------------------------------------------------
 * assistant-ui owns the composer's value. Setting `textarea.value` directly
 * appears to work and then loses the edit on the next render, because React
 * re-asserts the runtime's copy. So the DOM is only ever READ here (for the
 * caret, which the runtime does not expose); every write goes through
 * `composer.setText`.
 *
 * The trigger is deliberately narrow. `@` only opens the menu at a word
 * boundary, so an email address or a decorator in pasted text does not pop a
 * table picker in someone's face mid-sentence.
 */

type Table = { qualified: string; database: string; name: string };

/** How many matches the menu shows. Beyond this, keep typing. */
const MAX_RESULTS = 8;

/** Keys that dismiss or commit the menu, and so must not re-open it on keyup. */
const CLOSING_KEYS = new Set(["Escape", "Enter", "Tab"]);

/** The `@word` immediately before the caret, if the caret is inside one. */
function readQuery(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;

  // Only a word boundary opens the menu — "foo@bar" is an address, not a mention.
  const preceding = at === 0 ? "" : before[at - 1]!;
  if (preceding !== "" && !/\s/.test(preceding)) return null;

  const query = before.slice(at + 1);
  // A space closes it: the mention is one token.
  if (/\s/.test(query)) return null;

  return { query, start: at };
}

function rank(tables: Table[], query: string): Table[] {
  if (query === "") return tables.slice(0, MAX_RESULTS);
  const q = query.toLowerCase();
  return tables
    .map((t) => {
      const name = t.name.toLowerCase();
      // A prefix match on the bare name is what someone typing "yel" means;
      // a substring match anywhere is a fallback, ranked below it.
      const score = name.startsWith(q)
        ? 0
        : t.qualified.toLowerCase().startsWith(q)
          ? 1
          : name.includes(q)
            ? 2
            : t.qualified.toLowerCase().includes(q)
              ? 3
              : -1;
      return { t, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => a.score - b.score || a.t.name.localeCompare(b.t.name))
    .slice(0, MAX_RESULTS)
    .map((r) => r.t);
}

export function TableMention({ children }: { children: ReactNode }) {
  const composer = useComposerRuntime();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [query, setQuery] = useState<{ query: string; start: number } | null>(
    null,
  );
  const [active, setActive] = useState(0);

  // One fetch per mount. The schema changes far more slowly than someone types,
  // and introspect.ts already memoises it server-side on top of this.
  useEffect(() => {
    let live = true;
    void getSchemaNamespace()
      .then((namespace) => {
        if (!live) return;
        const found: Table[] = [];
        for (const [database, byTable] of Object.entries(namespace)) {
          for (const name of Object.keys(byTable)) {
            found.push({ qualified: `${database}.${name}`, database, name });
          }
        }
        found.sort((a, b) => a.name.localeCompare(b.name));
        setTables(found);
      })
      .catch(() => {
        // A composer that cannot offer tables is still a working composer.
      });
    return () => {
      live = false;
    };
  }, []);

  const textarea = useCallback(
    () => wrapRef.current?.querySelector("textarea") ?? null,
    [],
  );

  /**
   * Set while an insertion is landing.
   *
   * `setText` re-renders asynchronously, but the keyup that follows Enter fires
   * immediately — and at that instant the textarea still holds the OLD value,
   * `@yel`. Without this the sync would read that stale text and re-open the
   * menu it had just closed, one keystroke after choosing a table.
   */
  const insertingRef = useRef(false);

  const matches = useMemo(
    () => (query ? rank(tables, query.query) : []),
    [tables, query],
  );

  const close = useCallback(() => {
    setQuery(null);
    setActive(0);
  }, []);

  /** Read the caret out of the DOM — the runtime does not expose it. */
  const sync = useCallback(() => {
    if (insertingRef.current) return;
    const el = textarea();
    if (!el) return;
    setQuery(readQuery(el.value, el.selectionStart ?? el.value.length));
    setActive(0);
  }, [textarea]);

  const insert = useCallback(
    (table: Table) => {
      const el = textarea();
      if (!el || !query) return;
      const caret = el.selectionStart ?? el.value.length;
      const next =
        el.value.slice(0, query.start) +
        table.qualified +
        " " +
        el.value.slice(caret);

      insertingRef.current = true;
      composer.setText(next);
      close();

      // The runtime re-renders with the new value, so the caret has to be put
      // back after that lands or it snaps to the end of the text.
      const at = query.start + table.qualified.length + 1;
      requestAnimationFrame(() => {
        const again = textarea();
        if (again) {
          again.focus();
          again.setSelectionRange(at, at);
        }
        insertingRef.current = false;
      });
    },
    [composer, query, close, textarea],
  );

  const open = query !== null && matches.length > 0;

  // Keydown is captured on the wrapper so the menu sees the key before the
  // composer does — otherwise Enter sends the message instead of choosing the
  // highlighted table, which is the one mistake that would make this annoying
  // rather than useful.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!open) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActive((i) => (i + 1) % matches.length);
          break;
        case "ArrowUp":
          event.preventDefault();
          setActive((i) => (i - 1 + matches.length) % matches.length);
          break;
        case "Enter":
        case "Tab":
          event.preventDefault();
          event.stopPropagation();
          insert(matches[active] ?? matches[0]!);
          break;
        case "Escape":
          event.preventDefault();
          close();
          break;
      }
    };

    el.addEventListener("keydown", onKeyDown, true);
    return () => el.removeEventListener("keydown", onKeyDown, true);
  }, [open, matches, active, insert, close]);

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onInput={sync}
      // Keyup is only for caret movement (arrows, home/end) — the keys that
      // CLOSE the menu are excluded, because none of them changes the text and
      // re-reading it would find the same `@query` and reopen what was just
      // dismissed.
      onKeyUp={(event) => {
        if (CLOSING_KEYS.has(event.key)) return;
        sync();
      }}
      onClick={sync}
      onBlur={(event) => {
        // A click on the menu itself is not leaving the composer.
        if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
      }}
    >
      {open ? (
        <div className={styles.menu} role="listbox" aria-label="Tables">
          <div className={styles.hint}>
            Tables · <kbd>↑↓</kbd> move · <kbd>↵</kbd> insert · <kbd>esc</kbd>
          </div>
          {matches.map((table, i) => (
            <button
              key={table.qualified}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`${styles.item} ${i === active ? styles.active : ""}`}
              // Mouse-down rather than click: click fires after blur, by which
              // point the menu has already closed and taken the item with it.
              onMouseDown={(event) => {
                event.preventDefault();
                insert(table);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={styles.name}>{table.name}</span>
              <span className={styles.db}>{table.database}</span>
            </button>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

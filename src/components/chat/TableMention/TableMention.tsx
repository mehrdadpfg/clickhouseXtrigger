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
import { listBoardsForMentionAction } from "@/app/boards/actions";
import { boardMentionToken } from "@/components/boards/model";
import styles from "./TableMention.module.css";

/**
 * Type `@` in the composer to pick a table or a saved dashboard.
 *
 * The reader knows what they want to ask about long before they know what it is
 * called — "the taxi one", "the arrests table", "my NYC dashboard". Without this
 * the only way to find out is to ask the agent to list things and wait a turn
 * for the answer, which spends a round trip on something the browser can already
 * know.
 *
 * TWO ENTITY KINDS, ONE MENU
 * --------------------------
 * A table and a dashboard are picked the same way and inserted as the same kind
 * of `@token`, so they share this component rather than forking it. They differ
 * only in what the token then MEANS to the agent: a table token is resolved by
 * the agent's own schema tools, while a dashboard token is resolved server-side
 * and its tiles injected as context (see trigger/chat.ts). The token's spelling
 * for a board comes from the shared `boardMentionToken`, so the client and the
 * server agree on it exactly.
 *
 * The table schema comes from the same `getSchemaNamespace` the SQL editor's
 * autocomplete uses, so the two can never disagree about what exists; boards
 * come from the same picker action the "Add to dashboard" modal uses. Both are
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
 * picker in someone's face mid-sentence.
 */

type MentionKind = "table" | "board";

/** A table or a dashboard, reduced to what the menu draws and inserts. */
type MentionItem = {
  kind: MentionKind;
  /** Stable, unique key — also the React key. */
  key: string;
  /** The primary label: a table's name, or a board's title. */
  name: string;
  /** The secondary label: a table's database, or a board's tile count. */
  detail: string;
  /**
   * What actually goes in the box: `@name`, or `@db.name` where a bare name
   * would be ambiguous across databases, or `@Board_Slug` for a dashboard.
   *
   * Short on purpose. Writing a qualified name into the text left the reader
   * looking at "compare default.yellow_trips vs default.nypd_arrests" — the
   * database prefix is noise they did not type and cannot edit usefully, and it
   * buried the sentence they were writing. The token keeps something that still
   * reads like prose.
   */
  token: string;
  /** Lowercased text ranked against — the full qualified name / title. */
  haystack: string;
};

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

function rank(items: MentionItem[], query: string): MentionItem[] {
  if (query === "") return items.slice(0, MAX_RESULTS);
  const q = query.toLowerCase();
  return items
    .map((item) => {
      const name = item.name.toLowerCase();
      // A prefix match on the bare name is what someone typing "yel" means;
      // a substring match anywhere is a fallback, ranked below it.
      const score = name.startsWith(q)
        ? 0
        : item.haystack.startsWith(q)
          ? 1
          : name.includes(q)
            ? 2
            : item.haystack.includes(q)
              ? 3
              : -1;
      return { item, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name))
    .slice(0, MAX_RESULTS)
    .map((r) => r.item);
}

/**
 * The mention menu, over whatever input its host provides.
 *
 * `write` is injected rather than resolved here because the two hosts differ in
 * a way a hook cannot straddle: inside a chat the value belongs to
 * assistant-ui's runtime, and on the start screen it is plain React state with
 * no runtime in the tree at all. `useComposerRuntime` THROWS outside a
 * provider, so it cannot be called speculatively and discarded — which is
 * exactly what a single component with an optional prop would have to do.
 */
function MentionCore({
  children,
  write,
  externalText,
}: {
  children: ReactNode;
  write: (next: string) => void;
  /**
   * The composer's authoritative text, when the host can supply it (the chat's
   * runtime). The mirror otherwise learns the text only from input/keyup/click,
   * which a SEND does not fire — assistant-ui clears the textarea
   * programmatically, so without this the highlight kept ghosting the sent
   * message over the empty box. When present it is the source of truth for the
   * mirror; the DOM is still read for the caret, which no runtime exposes.
   */
  externalText?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [query, setQuery] = useState<{ query: string; start: number } | null>(
    null,
  );
  const [active, setActive] = useState(0);
  /** The composer's current text, mirrored so the chip row can derive from it. */
  const [text, setText] = useState("");

  // One fetch per mount, for both kinds. The schema and the board list both
  // change far more slowly than someone types (introspect.ts memoises the
  // schema server-side on top of this), so neither is refetched per keystroke.
  useEffect(() => {
    let live = true;

    const tablesP = getSchemaNamespace()
      .then((namespace) => {
        const raw: { qualified: string; database: string; name: string }[] = [];
        for (const [database, byTable] of Object.entries(namespace)) {
          for (const name of Object.keys(byTable)) {
            raw.push({ qualified: `${database}.${name}`, database, name });
          }
        }
        // A bare @name is only safe where the name is unique; otherwise the
        // token has to carry the database or the agent cannot tell them apart.
        const seen = new Map<string, number>();
        for (const t of raw) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
        return raw.map<MentionItem>((t) => ({
          kind: "table",
          key: `table:${t.qualified}`,
          name: t.name,
          detail: t.database,
          token: (seen.get(t.name) ?? 0) > 1 ? `@${t.qualified}` : `@${t.name}`,
          haystack: t.qualified.toLowerCase(),
        }));
      })
      .catch(() => [] as MentionItem[]);

    const boardsP = listBoardsForMentionAction()
      .then((boards) =>
        boards.map<MentionItem>((b) => ({
          kind: "board",
          key: `board:${b.id}`,
          name: b.title,
          detail: `${b.tileCount} ${b.tileCount === 1 ? "tile" : "tiles"}`,
          token: boardMentionToken(b.title),
          haystack: b.title.toLowerCase(),
        })),
      )
      .catch(() => [] as MentionItem[]);

    void Promise.all([tablesP, boardsP]).then(([tables, boards]) => {
      if (!live) return;
      // Tables first, then boards; each group alphabetical. A bare `@` most
      // often wants a table, and grouping the two kinds keeps the menu legible.
      tables.sort((a, b) => a.name.localeCompare(b.name));
      boards.sort((a, b) => a.name.localeCompare(b.name));
      setItems([...tables, ...boards]);
    });

    return () => {
      live = false;
    };
  }, []);

  const mirrorRef = useRef<HTMLDivElement>(null);

  // Follow the host's authoritative text when it gives one. This is what clears
  // the highlight on send: the runtime resets to "" with no DOM event, so the
  // DOM-driven sync never runs — this effect does. Also closes a menu left open
  // over text that vanished under it.
  useEffect(() => {
    if (externalText === undefined) return;
    setText(externalText);
    if (externalText === "") setQuery(null);
  }, [externalText]);

  const textarea = useCallback(
    () =>
      wrapRef.current?.querySelector<HTMLTextAreaElement | HTMLInputElement>(
        "textarea, input[type=text], input:not([type])",
      ) ?? null,
    [],
  );

  /**
   * Set while THIS component is writing to the composer (an insert, or a chip
   * removal).
   *
   * `setText` re-renders asynchronously, but the keyup that follows Enter fires
   * immediately — and at that instant the textarea still holds the OLD value,
   * `@yel`. Without this the sync would read that stale text and re-open the
   * menu it had just closed, one keystroke after choosing a table.
   */
  const writingRef = useRef(false);

  const matches = useMemo(
    () => (query ? rank(items, query.query) : []),
    [items, query],
  );

  const close = useCallback(() => {
    setQuery(null);
    setActive(0);
  }, []);

  /**
   * Read the caret out of the DOM — the runtime does not expose it.
   *
   * The highlight is reset only when the QUERY changes, not on every sync.
   * Resetting unconditionally made ArrowDown look like it moved up: the arrow
   * advanced the highlight, then the keyup that followed re-synced and put it
   * straight back to the first row.
   */
  const sync = useCallback(() => {
    if (writingRef.current) return;
    const el = textarea();
    if (!el) return;
    const next = readQuery(el.value, el.selectionStart ?? el.value.length);
    setText(el.value);
    setQuery((prev) => {
      if (prev?.query !== next?.query || prev?.start !== next?.start) {
        setActive(0);
      }
      return next;
    });
  }, [textarea]);

  const insert = useCallback(
    (item: MentionItem) => {
      const el = textarea();
      if (!el || !query) return;
      const caret = el.selectionStart ?? el.value.length;
      const next =
        el.value.slice(0, query.start) + item.token + " " + el.value.slice(caret);

      writingRef.current = true;
      write(next);
      // Mirror it locally too: sync() is suppressed while the insert lands, so
      // without this the chip row would not see the mention until the next
      // keystroke.
      setText(next);
      close();

      // The runtime re-renders with the new value, so the caret has to be put
      // back after that lands or it snaps to the end of the text.
      const at = query.start + item.token.length + 1;
      requestAnimationFrame(() => {
        const again = textarea();
        if (again) {
          again.focus();
          again.setSelectionRange(at, at);
        }
        writingRef.current = false;
      });
    },
    [write, query, close, textarea],
  );

  /**
   * The composer text with every recognised @token wrapped for colour.
   *
   * Only tokens that name a table or a dashboard that actually exists are
   * highlighted, so "@lunch" in a sentence stays plain and the colour means
   * something: it is confirmation the mention resolved, not decoration on any
   * word after an @. Dashboards get their own colour so the two kinds read
   * apart at a glance — a table token and a board token are not the same thing
   * to the agent.
   *
   * A trailing newline gets a zero-width space appended — a mirror div collapses
   * a final "\n" where a textarea keeps the empty line, and without it the two
   * drift apart by one line as soon as someone presses Enter.
   */
  const highlighted = useMemo(() => {
    const tableTokens = new Set(
      items.filter((i) => i.kind === "table").map((i) => i.token),
    );
    const boardTokens = new Set(
      items.filter((i) => i.kind === "board").map((i) => i.token),
    );
    if (tableTokens.size === 0 && boardTokens.size === 0) return text;

    const parts: ReactNode[] = [];
    const pattern = /(^|\s)(@[\w.]+)/g;
    let last = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const token = match[2]!;
      // A token that resolves to both (a board titled like a table) reads as a
      // table — the schema is the more likely intent behind a bare word.
      const isTable = tableTokens.has(token);
      const isBoard = !isTable && boardTokens.has(token);
      if (!isTable && !isBoard) continue;
      const start = match.index + match[1]!.length;
      if (start > last) parts.push(text.slice(last, start));
      parts.push(
        <span key={start} className={isBoard ? styles.tokenBoard : styles.token}>
          {token}
        </span>,
      );
      last = start + token.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length === 0 ? `${text}\u200b` : [...parts, "\u200b"];
  }, [items, text]);

  /**
   * Copy the input's own metrics onto the mirror.
   *
   * Read from the live element rather than duplicated in CSS: the composer's
   * type is set by the host's stylesheet (and differs between the chat's
   * textarea and the start screen's input), so anything hard-coded here would
   * be right on one surface and visibly ghosted on the other. Every property
   * below changes where a glyph lands; miss one and the highlight sits beside
   * the text instead of under it.
   */
  useEffect(() => {
    const el = textarea();
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;

    const apply = () => {
      const c = getComputedStyle(el);
      for (const prop of [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "fontStyle",
        "letterSpacing",
        "wordSpacing",
        "lineHeight",
        "textIndent",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "textTransform",
        // Copied because the mirror INHERITS these from its context, and the
        // input overrides them locally. The start screen centres its hero
        // column, so without textAlign the mirror rendered "aoeuaoe" centred
        // over a left-aligned (transparent) input — ghost text beside its own
        // caret. The chat's textarea sits in left-aligned context, which is why
        // it never showed there.
        "textAlign",
        "direction",
        "whiteSpace",
        "wordBreak",
        "overflowWrap",
      ] as const) {
        mirror.style[prop] = c[prop];
      }
      // A single-line <input> never wraps; a textarea does. Matching this is
      // what stops a long line wrapping in the mirror but scrolling in the box.
      if (el.tagName === "INPUT") {
        mirror.style.whiteSpace = "pre";
      }
      // Sit exactly over the control's own box. The wrapper also contains the
      // send button and the composer's padding, so its inset is not where the
      // text is — this has to be measured, not assumed.
      const box = el.getBoundingClientRect();
      const origin = mirror.offsetParent?.getBoundingClientRect();
      mirror.style.top = `${box.top - (origin?.top ?? 0)}px`;
      mirror.style.left = `${box.left - (origin?.left ?? 0)}px`;
      mirror.style.width = `${box.width}px`;
      mirror.style.height = `${box.height}px`;

      // The real text goes invisible only once the mirror is placed, so a
      // failure above leaves readable (unhighlighted) text rather than none.
      el.style.color = "transparent";
      el.style.caretColor =
        getComputedStyle(document.documentElement).getPropertyValue("--text") ||
        "#fafafa";
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.style.color = "";
      el.style.caretColor = "";
    };
  }, [textarea]);

  /** Keep the mirror pinned to the input's scroll — long text would drift. */
  useEffect(() => {
    const el = textarea();
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    const onScroll = () => {
      mirror.scrollTop = el.scrollTop;
      mirror.scrollLeft = el.scrollLeft;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [textarea]);

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
        <div
          className={styles.menu}
          role="listbox"
          aria-label="Tables and dashboards"
        >
          <div className={styles.hint}>
            Tables &amp; dashboards · <kbd>↑↓</kbd> move · <kbd>↵</kbd> insert ·{" "}
            <kbd>esc</kbd>
          </div>
          {matches.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`${styles.item} ${i === active ? styles.active : ""}`}
              // Mouse-down rather than click: click fires after blur, by which
              // point the menu has already closed and taken the item with it.
              onMouseDown={(event) => {
                event.preventDefault();
                insert(item);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={styles.name}>{item.name}</span>
              {item.kind === "board" ? (
                <span className={styles.kind}>dashboard</span>
              ) : null}
              <span className={styles.db}>{item.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
      {/* The highlight layer sits UNDER the real input, which is made
          transparent, so the two are the same text in the same place and the
          caret still belongs to the input. */}
      <div ref={mirrorRef} className={styles.mirror} aria-hidden="true">
        {highlighted}
      </div>
      {children}
    </div>
  );
}

/** Inside a chat: assistant-ui owns the value, so it is written through the runtime. */
function ComposerMention({ children }: { children: ReactNode }) {
  const composer = useComposerRuntime();
  const write = useCallback(
    (next: string) => composer.setText(next),
    [composer],
  );

  // Track the runtime's text so the mirror can follow a programmatic clear (a
  // send) that fires no DOM event. subscribe → re-read getState().text.
  const [text, setText] = useState(() => composer.getState().text ?? "");
  useEffect(() => {
    const read = () => setText(composer.getState().text ?? "");
    read();
    return composer.subscribe(read);
  }, [composer]);

  return (
    <MentionCore write={write} externalText={text}>
      {children}
    </MentionCore>
  );
}

export function TableMention({
  children,
  value,
  onChange,
}: {
  children: ReactNode;
  /**
   * Supplied by a host that owns its own input — the start screen's plain
   * <input>. When present the composer runtime is never touched, which is the
   * whole point: that page has no assistant-ui provider, and reaching for the
   * runtime there throws and takes the route down with it.
   */
  value?: string;
  onChange?: (next: string) => void;
}) {
  if (value !== undefined && onChange !== undefined) {
    return (
      <MentionCore write={onChange} externalText={value}>
        {children}
      </MentionCore>
    );
  }
  return <ComposerMention>{children}</ComposerMention>;
}

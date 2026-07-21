/**
 * Resolving an @-mentioned dashboard into agent context.
 *
 * A table @mention needs no server help — the token IS the context, and the
 * agent reads the schema for it with listTables/describeTable. A board has no
 * such tool: nothing the agent can call would tell it what tiles a dashboard
 * holds. So when the reader @-mentions a board, its summary is loaded here and
 * injected into the turn (see chat.ts `prepareMessages`), so the agent can
 * reason about "this dashboard" — its tiles, and each tile's title, kind and SQL.
 *
 * Server-only: it reads Postgres. The token spelling comes from the shared
 * `boardMentionToken`, so a title is matched here exactly as the composer wrote it.
 */
import { boardMentionToken } from "@/components/boards/model";
import { listBoardsWithTileCount, listTiles } from "@/lib/db/boards";

/** Every `@word` token in a block of text, at a word boundary — the composer's rule. */
function mentionTokens(text: string): Set<string> {
  const found = new Set<string>();
  const pattern = /(^|\s)(@[\w.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.add(match[2]!);
  return found;
}

/**
 * The context block for every board @-mentioned anywhere in `text`, or null.
 *
 * `text` is the concatenation of the conversation's user messages, so a board
 * mentioned in an earlier turn keeps its context on later turns rather than
 * going cold the moment the reader stops naming it. A board with no tiles still
 * resolves — the agent should hear that a named dashboard is empty, not that it
 * does not exist.
 */
export async function loadMentionedBoardsContext(
  text: string,
): Promise<string | null> {
  if (!text.includes("@")) return null;

  const tokens = mentionTokens(text);
  if (tokens.size === 0) return null;

  let boards;
  try {
    boards = await listBoardsWithTileCount();
  } catch (cause) {
    // Context is a bonus, never the turn: a dead board read must not fail the run.
    console.error("Could not load boards for @-mention context", cause);
    return null;
  }

  const mentioned = boards.filter((b) => tokens.has(boardMentionToken(b.title)));
  if (mentioned.length === 0) return null;

  const blocks: string[] = [];
  for (const board of mentioned) {
    let tiles;
    try {
      tiles = await listTiles(board.id);
    } catch (cause) {
      console.error("Could not load tiles for @-mentioned board", board.id, cause);
      continue;
    }
    const lines =
      tiles.length === 0
        ? ["(no tiles yet)"]
        : tiles.map(
            (tile, index) =>
              `${index + 1}. "${tile.title}" — ${tile.kind} — ${tile.sql}`,
          );
    blocks.push(
      `Dashboard "${board.title}" (${tiles.length} tile${tiles.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
    );
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

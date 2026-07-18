import { DiscoverBoard } from "@/components/explore";

/**
 * "/explore/discover" — the findings board.
 *
 * The scope rides in the URL (so this is stateless and reloadable). This server
 * page only parses it and hands it to the client board, which starts the durable
 * discovery run, subscribes to it, and renders the relationship map + finding
 * cards as they land.
 */
export const dynamic = "force-dynamic";

function parseTables(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ tables?: string; focus?: string }>;
}) {
  const { tables: rawTables, focus } = await searchParams;
  const tables = parseTables(rawTables);

  return <DiscoverBoard tables={tables} {...(focus ? { focus } : {})} />;
}

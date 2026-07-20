/**
 * Proves the widened tile write path REJECTS bad payloads instead of accepting
 * them and dropping the fields (the [4] failure mode).
 *
 * Every case below is decided by UpdateTile.safeParse at the top of
 * updateTileAction, before getTile touches the database — so "reached the DB"
 * is itself the signal that a payload passed the gate.
 *
 * That the guard cases reject AT ALL is the load-bearing result: a refinement
 * cannot fire on a key zod has stripped. Before chartType/encodings/horizontal
 * were named in the UpdateTile shape these same payloads all returned {ok:true}
 * having written nothing, which is the regression this file exists to catch.
 *
 * Run it with `bun run scripts/check-tile-update-gate.ts`. It needs no database:
 * rejections happen upstream of one, and the accepted case is expected to fail
 * downstream against a tile id that does not exist.
 */
import { updateTileAction } from "@/app/boards/actions";

const TILE = "00000000-0000-4000-8000-000000000000";

type Case = { name: string; input: unknown; expect: "reject" | "pass-gate" };

const cases: Case[] = [
  {
    name: "chartType = TABLE_VIEW sentinel",
    input: { tileId: TILE, chartType: "__table__", encodings: { x: "day" } },
    expect: "reject",
  },
  {
    name: "chartType with no encodings",
    input: { tileId: TILE, chartType: "Bar Chart" },
    expect: "reject",
  },
  {
    name: "chartType with empty encodings",
    input: { tileId: TILE, chartType: "Bar Chart", encodings: {} },
    expect: "reject",
  },
  {
    name: "well-formed chart payload",
    input: {
      tileId: TILE,
      chartType: "Bar Chart",
      encodings: { x: "day", y: "revenue" },
      horizontal: true,
    },
    expect: "pass-gate",
  },
];

let failures = 0;

for (const c of cases) {
  let result: { ok: boolean; error?: string };
  try {
    result = (await updateTileAction(c.input)) as { ok: boolean; error?: string };
  } catch (cause) {
    // A throw can only come from the DB, which is downstream of the gate.
    result = { ok: false, error: `THREW: ${String(cause)}` };
  }

  // The gate's own rejections are the two guard messages; anything else that
  // fails did so downstream (no such tile / no database), i.e. it passed.
  const guardMessages = ["A table is a tile kind", "A chart type needs encodings"];
  const rejectedByGate = guardMessages.some((m) => result.error?.startsWith(m));
  const actual = rejectedByGate ? "reject" : "pass-gate";
  const ok = actual === c.expect;
  if (!ok) failures++;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}\n` +
      `      expected ${c.expect}, got ${actual} -> ${JSON.stringify(result)}\n`,
  );
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

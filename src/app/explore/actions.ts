"use server";

import { randomUUID } from "node:crypto";
import { auth } from "@trigger.dev/sdk";
import { discoverScope } from "@/trigger/discover";
import { DiscoveryScope } from "@/lib/discover/model";

/**
 * The Explore surface's writes.
 *
 * Starting a discovery fans one durable run out over the curated scope and hands
 * the browser back a tag-scoped token to watch it fill in — the same shape as
 * the compare fork. Nothing here runs SQL or touches a table name: the scope is
 * a list of "database.table" ids the human chose, and the agent takes it from
 * there behind the task's readonly guards.
 */

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

function fail(error: string): Err {
  return { ok: false, error };
}

export async function startDiscoveryAction(
  input: unknown,
): Promise<
  Ok<{ sessionId: string; tag: string; accessToken: string; runId: string }> | Err
> {
  const parsed = DiscoveryScope.safeParse(input);
  if (!parsed.success) return fail("Pick at least one table to explore.");

  try {
    const sessionId = randomUUID();
    const tag = `discover:${sessionId}`;

    const handle = await discoverScope.trigger(parsed.data, { tags: [tag] });

    // Scoped to read exactly this run's tag — the credential the browser gets
    // can see this discovery and nothing else.
    const accessToken = await auth.createPublicToken({
      scopes: { read: { tags: [tag] } },
      expirationTime: "1h",
    });

    return { ok: true, sessionId, tag, accessToken, runId: handle.id };
  } catch (cause) {
    console.error("startDiscovery failed", cause);
    return fail(
      cause instanceof Error
        ? cause.message
        : "Could not start discovery. Try again.",
    );
  }
}

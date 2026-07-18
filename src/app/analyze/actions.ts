"use server";

import { randomUUID } from "node:crypto";
import { auth } from "@trigger.dev/sdk";
import { runVerbTask } from "@/trigger/verb";
import { VerbInput } from "@/lib/discover/verbs";

/**
 * The Analyze panel's writes.
 *
 * Firing a verb against a chart is the same durable-run + tag-scoped-token shape
 * the Explore walk used (and Compare uses): trigger one `run-verb` run and hand
 * the browser back a credential that can watch exactly that run and nothing else.
 * Relocated out of the (soon-deleted) Explore surface so the docked Analyze panel
 * has a home that survives.
 */

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

function fail(error: string): Err {
  return { ok: false, error };
}

/**
 * Fire one verb against an analysis source (a chart's title/sql/chartType). Same
 * shape as the old Explore walk: trigger a durable run and hand back a tag-scoped
 * token the section subscribes with.
 */
export async function startVerbAction(
  input: unknown,
): Promise<Ok<{ tag: string; accessToken: string; runId: string }> | Err> {
  const parsed = VerbInput.safeParse(input);
  if (!parsed.success) return fail("Couldn't run that on this chart.");

  try {
    const tag = `verb:${randomUUID()}`;
    const handle = await runVerbTask.trigger(parsed.data, { tags: [tag] });
    const accessToken = await auth.createPublicToken({
      scopes: { read: { tags: [tag] } },
      expirationTime: "1h",
    });
    return { ok: true, tag, accessToken, runId: handle.id };
  } catch (cause) {
    console.error("startVerb failed", cause);
    return fail(
      cause instanceof Error ? cause.message : "Could not run that. Try again.",
    );
  }
}

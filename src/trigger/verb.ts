/**
 * Run one verb against a finding — the "walk" step.
 *
 * A thin durable wrapper around `runVerb` (the agentic work lives in lib, like
 * discovery). It runs the verb, then executes the child card's SQL so the walk
 * card renders from embedded rows without sending SQL from the browser, and
 * publishes progress + the result as metadata for the card to subscribe to.
 */
import { metadata, schemaTask } from "@trigger.dev/sdk";
import { runReadonlyQuery } from "@/lib/clickhouse/run";
import { runVerb, VerbInput } from "@/lib/discover/verbs";
import type { EnrichedVerb, ResultRow, VerbMetadata } from "@/lib/discover/model";

export const runVerbTask = schemaTask({
  id: "run-verb",
  schema: VerbInput,
  // Some verbs (association across every column) probe a lot; give them room.
  maxDuration: 300,
  retry: { maxAttempts: 1 },
  queue: { name: "discover", concurrencyLimit: 3 },

  run: async (input) => {
    const initial: VerbMetadata = {
      status: "profiling",
      verb: input.verb,
      parent: input.finding.finding,
      result: null,
      error: null,
    };
    metadata.replace(initial);

    let probes = 0;
    try {
      const result = await runVerb(input, () => {
        probes += 1;
        metadata.set("probeCount", probes);
      });

      // Run the child card's SQL so it's self-contained, exactly like a nominated
      // finding. A query that fails is kept but marked — an honest failed card.
      let rows: ResultRow[] = [];
      let error: string | null = null;
      try {
        rows = ((await runReadonlyQuery(result.sql)) as ResultRow[]).slice(0, 200);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Query failed.";
      }

      const enriched: EnrichedVerb = { ...result, rows, error };
      metadata.set("result", enriched).set("status", "complete");
      return enriched;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Verb failed.";
      metadata.set("status", "failed").set("error", message);
      throw cause;
    }
  },
});

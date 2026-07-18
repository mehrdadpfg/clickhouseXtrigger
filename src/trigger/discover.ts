/**
 * Discover — profile a curated scope into a relationship map + nominated findings.
 *
 * A thin durable wrapper around `runDiscovery` (the agentic work lives in lib,
 * exactly like the compare planner). The task exists so discovery is a real
 * background run: it survives a reload, the board subscribes to it by tag, and
 * its progress is published as metadata as it probes the data.
 *
 * DATASET-AGNOSTIC: the scope is a handful of "database.table" ids and nothing
 * more. Which tables relate, and what's worth a card, is decided at runtime by
 * the agent against the live schema — never baked in here.
 */
import { metadata, schemaTask } from "@trigger.dev/sdk";
import { executeFindings, runDiscovery } from "@/lib/discover/discover";
import {
  DiscoveryScope,
  type DiscoveryMetadata,
  type EnrichedDiscovery,
} from "@/lib/discover/model";

export const discoverScope = schemaTask({
  id: "discover-scope",
  schema: DiscoveryScope,
  // The agent probes the data across several steps; give it room, but bounded.
  maxDuration: 180,
  // A discovery that fails fails for a reason a retry won't fix (a scope with no
  // usable tables, a model error). One attempt; the analyst re-runs.
  retry: { maxAttempts: 1 },
  // Every run points at one ClickHouse and one model. A couple at a time.
  queue: { name: "discover", concurrencyLimit: 2 },

  run: async (scope) => {
    // Publish identity first, so the board can show "profiling…" for this exact
    // scope the instant it sees the run — before any probe has returned.
    const initial: DiscoveryMetadata = {
      status: "profiling",
      scope,
      result: null,
      error: null,
    };
    metadata.replace(initial);

    let probes = 0;
    try {
      const result = await runDiscovery(scope, () => {
        // A cheap progress signal: how many times the agent has looked at the
        // data so far. The board can show it ticking up while it waits.
        probes += 1;
        metadata.set("probeCount", probes);
      });

      // Run each finding's SQL so the card is self-contained — the board never
      // sends SQL from the browser, and a finding that no longer runs is marked.
      const findings = await executeFindings(result.findings);
      const enriched: EnrichedDiscovery = {
        relationships: result.relationships,
        findings,
      };

      metadata.set("result", enriched).set("status", "complete");
      return enriched;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Discovery failed.";
      metadata.set("status", "failed").set("error", message);
      throw cause;
    }
  },
});

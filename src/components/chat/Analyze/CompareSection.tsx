"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import { Spinner } from "@/components/ui";
import {
  CompareBody,
  runStatusToBranchStatus,
  type BranchView,
  type CompareView,
} from "@/components/compare";
// Type-only: erased at build, so the server-only compare task (and its
// ClickHouse client) never bundles into this client component.
import type { CompareBranchMetadata } from "@/trigger/compare";
import { saveCompareBoardAction } from "@/app/compare/actions";
import { useAnalyze } from "./AnalyzeProvider";
import styles from "./Analyze.module.css";

/**
 * The "Compare variants" section's live body, inside the docked Analyze panel.
 *
 * The plan + fork and the persistent intent (seeds, culls, next colour slot)
 * live in the provider, keyed by chart, so the comparison survives the section
 * collapsing and the panel switching charts — mounted here only once the section
 * is first expanded. This component owns the realtime half: it subscribes to the
 * session's branch runs by tag, maps each run's metadata into a BranchView, and
 * hands the set to the prop-driven CompareBody on one shared scale. Adding and
 * culling variants route back through the provider; only complete branches can
 * be saved onto a board.
 */
export function CompareSection({ analysisId }: { analysisId: string }) {
  const {
    compareSessionFor,
    ensureCompareRun,
    addCompareVariant,
    cullCompareBranch,
  } = useAnalyze();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start the fork the first time the section is expanded; ensureCompareRun is
  // idempotent, so reopening or a re-render never re-plans it.
  useEffect(() => {
    ensureCompareRun(analysisId);
  }, [analysisId, ensureCompareRun]);

  const session = compareSessionFor(analysisId);
  const ready = session?.status === "ready" ? session : null;

  const { runs } = useRealtimeRunsWithTag(ready?.sessionTag ?? "", {
    accessToken: ready?.accessToken,
    enabled: Boolean(ready),
  });

  // Each variant's live SQL, read off the run metadata — needed to save a branch
  // onto a board. Only complete branches (which have reported) are ever saved.
  const sqlById = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs ?? []) {
      const md = run.metadata as CompareBranchMetadata | undefined;
      if (md?.variant?.id && md.variant.sql) map.set(md.variant.id, md.variant.sql);
    }
    return map;
  }, [runs]);

  // Seeds hold identity + colour before a run reports; the run's metadata takes
  // over the moment it lands. Keyed by variant id so the two never double up.
  const branches = useMemo<BranchView[]>(() => {
    if (!ready) return [];
    const culled = new Set(ready.culled);
    const byId = new Map<string, BranchView>();
    for (const s of ready.seeds) {
      byId.set(s.id, {
        id: s.id,
        label: s.label,
        ...(s.description ? { description: s.description } : {}),
        colorSlot: s.colorSlot,
        status: "queued",
        points: [],
        headline: null,
        delta: null,
      });
    }
    for (const run of runs ?? []) {
      const md = run.metadata as CompareBranchMetadata | undefined;
      const variant = md?.variant;
      const id =
        variant?.id ??
        run.tags?.find((t) => t.startsWith("variant:"))?.slice("variant:".length);
      if (!id) continue;
      const prev = byId.get(id);
      byId.set(id, {
        id,
        label: variant?.label ?? prev?.label ?? "Variant",
        ...(variant?.description ?? prev?.description
          ? { description: variant?.description ?? prev?.description }
          : {}),
        colorSlot: variant?.colorSlot ?? prev?.colorSlot ?? 0,
        status: md?.status ?? runStatusToBranchStatus(run.status),
        points: md?.points ?? [],
        headline: md?.headline ?? null,
        delta: md?.delta ?? null,
        error: md?.error ?? null,
      });
    }
    return [...byId.values()]
      .filter((b) => !culled.has(b.id))
      .sort((a, b) => a.colorSlot - b.colorSlot);
  }, [ready, runs]);

  async function buildBoard(picked: BranchView[]) {
    if (!ready) return;
    const rows = picked
      .map((b) => ({ label: b.label, sql: sqlById.get(b.id) ?? "" }))
      .filter((r) => r.sql !== "");
    if (rows.length === 0) return;
    setBusy(true);
    const res = await saveCompareBoardAction({
      title: ready.base.question.slice(0, 80),
      branches: rows,
    });
    setBusy(false);
    if (res.ok) router.push(`/boards/${res.boardId}`);
    else setError(res.error);
  }

  if (session?.status === "error") {
    return (
      <p className={styles.verbError} role="alert">
        {session.error}
      </p>
    );
  }

  if (!ready) {
    return (
      <div className={styles.verbLoading}>
        <Spinner label="" />
        <span className={styles.verbLoadingNote}>planning variants…</span>
      </div>
    );
  }

  const view: CompareView = { base: ready.base, branches };

  return (
    <div className={styles.compareBody}>
      {error ? (
        <p className={styles.verbError} role="alert">
          {error}
        </p>
      ) : null}
      <CompareBody
        view={view}
        busy={busy}
        onCull={(id) => cullCompareBranch(analysisId, id)}
        onAddVariant={async (input) => {
          setBusy(true);
          const res = await addCompareVariant(analysisId, input);
          setBusy(false);
          if (!res.ok && res.error) setError(res.error);
        }}
        onPin={(branch) => void buildBoard([branch])}
        onBuildBoard={() =>
          void buildBoard(branches.filter((b) => b.status === "complete"))
        }
      />
    </div>
  );
}

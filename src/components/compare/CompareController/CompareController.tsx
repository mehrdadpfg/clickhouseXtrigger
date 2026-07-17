"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";
import { Spinner } from "@/components/ui";
// Type-only: erased at build, so the server-only compare task never bundles here.
// (Typing the hook with `typeof compareBranch` would force a *value* import of
// the task — and its ClickHouse client — into this client bundle, so we don't.)
import type { CompareBase, CompareBranchMetadata } from "@/trigger/compare";
import {
  addCompareVariantAction,
  saveCompareBoardAction,
  startCompareAction,
  type VariantSeed,
} from "@/app/compare/actions";
import { CompareSidebar } from "../CompareSidebar/CompareSidebar";
import type { BranchView, CompareView } from "../model";

/**
 * The live wiring behind the Compare drawer.
 *
 * It plans + forks the comparison (startCompareAction), then subscribes to the
 * session's branch runs by tag and maps each run's metadata into a BranchView the
 * prop-driven CompareSidebar renders. New variants fork into the SAME tag, so the
 * one subscription keeps filling as branches are added; culling is local, so it
 * never disturbs a survivor's colour.
 */

interface Session {
  sessionId: string;
  sessionTag: string;
  accessToken: string;
  base: CompareBase;
}

/** Trigger run status → branch status, for the window before metadata lands. */
function runStatusToBranch(status: string): BranchView["status"] {
  if (status === "COMPLETED") return "complete";
  if (["FAILED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "CANCELED", "INTERRUPTED", "EXPIRED"].includes(status)) {
    return "failed";
  }
  if (["EXECUTING", "REATTEMPTING", "WAITING", "FROZEN"].includes(status)) return "running";
  return "queued";
}

export function CompareController({
  question,
  sql,
  onClose,
}: {
  question: string;
  sql: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [seeds, setSeeds] = useState<VariantSeed[]>([]);
  const [culled, setCulled] = useState<Set<string>>(new Set());
  const [nextSlot, setNextSlot] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Plan + fork once, on open.
  useEffect(() => {
    let live = true;
    void startCompareAction({ question, sql }).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSession({
        sessionId: res.sessionId,
        sessionTag: res.sessionTag,
        accessToken: res.accessToken,
        base: res.base,
      });
      setSeeds(res.variants);
      setNextSlot(res.variants.length);
    });
    return () => {
      live = false;
    };
  }, [question, sql]);

  const { runs } = useRealtimeRunsWithTag(session?.sessionTag ?? "", {
    accessToken: session?.accessToken,
    enabled: Boolean(session),
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
    const byId = new Map<string, BranchView>();
    for (const s of seeds) {
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
        status: md?.status ?? runStatusToBranch(run.status),
        points: md?.points ?? [],
        headline: md?.headline ?? null,
        delta: md?.delta ?? null,
        error: md?.error ?? null,
      });
    }
    return [...byId.values()]
      .filter((b) => !culled.has(b.id))
      .sort((a, b) => a.colorSlot - b.colorSlot);
  }, [seeds, runs, culled]);

  async function buildBoard(picked: BranchView[]) {
    const rows = picked
      .map((b) => ({ label: b.label, sql: sqlById.get(b.id) ?? "" }))
      .filter((r) => r.sql !== "");
    if (rows.length === 0) return;
    setBusy(true);
    const res = await saveCompareBoardAction({
      title: (session?.base.question ?? question).slice(0, 80),
      branches: rows,
    });
    setBusy(false);
    if (res.ok) {
      onClose();
      router.push(`/boards/${res.boardId}`);
    } else {
      setError(res.error);
    }
  }

  // --- render ---------------------------------------------------------------

  if (error && !session) {
    return (
      <Drawer onClose={onClose}>
        <p className="px-1 text-[13px] text-[var(--critical)]">{error}</p>
      </Drawer>
    );
  }

  if (!session) {
    return (
      <Drawer onClose={onClose}>
        <div className="flex items-center gap-2 px-1 text-[13px] text-[var(--text-muted)]">
          <Spinner size="md" /> Planning variants…
        </div>
      </Drawer>
    );
  }

  const view: CompareView = { base: session.base, branches };

  return (
    <CompareSidebar
      view={view}
      busy={busy}
      onClose={onClose}
      onCull={(id) => setCulled((prev) => new Set(prev).add(id))}
      onAddVariant={async ({ label, description, custom }) => {
        const change = custom ?? description ?? label;
        const slot = nextSlot;
        setNextSlot((s) => s + 1);
        setBusy(true);
        const res = await addCompareVariantAction({
          sessionId: session.sessionId,
          base: session.base,
          sql,
          change,
          colorSlot: slot,
        });
        setBusy(false);
        if (res.ok) setSeeds((prev) => [...prev, res.variant]);
        else setError(res.error);
      }}
      onPin={(branch) => void buildBoard([branch])}
      onBuildBoard={() =>
        void buildBoard(branches.filter((b) => b.status === "complete"))
      }
    />
  );
}

/** The bare drawer shell, reused for the loading and error states. */
function Drawer({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      style={{ background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-full w-[440px] max-w-[92vw] flex-col border-l border-[var(--border-strong)] bg-background p-[18px]"
        role="dialog"
        aria-label="Compare variants"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-[9px]">
          <span className="text-[15px] text-brand" aria-hidden="true">
            ⑃
          </span>
          <h2 className="m-0 text-[14.5px] font-semibold text-[var(--text)]">
            Compare variants
          </h2>
          <button
            type="button"
            className="ml-auto cursor-pointer border-0 bg-transparent text-[16px] leading-none text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

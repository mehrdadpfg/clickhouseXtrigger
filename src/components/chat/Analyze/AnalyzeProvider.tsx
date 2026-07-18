"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { startVerbAction } from "@/app/analyze/actions";
import {
  addCompareVariantAction,
  startCompareAction,
  type VariantSeed,
} from "@/app/compare/actions";
import type { CompareBase } from "@/trigger/compare";
import type { VerbKey } from "@/lib/discover/model";

/**
 * One chart handed to the Analyze panel to work over.
 *
 * `id` is the chart's stable identity in this session (its tool-call id): opening
 * the same chart twice focuses the existing analysis rather than adding a
 * duplicate. `title` doubles as the verb "finding"/"signal" when a section runs;
 * `sql`, `chartType` and `data` are the proof material later stages fork from.
 */
export interface AnalysisSource {
  id: string;
  title: string;
  sql?: string;
  chartType?: string;
  data?: Record<string, unknown>[];
}

/** The panel's lazy accordion sections — the four verbs plus Compare. */
export type SectionKey = "why" | "disagree" | "shape" | "weird" | "compare";

/**
 * A verb section's cached run, keyed per (analysis, verb). It survives a section
 * collapsing/reopening and the panel switching charts, so a verb runs at most
 * once per chart no matter how the user navigates.
 */
export type VerbRunState =
  | { status: "starting" }
  | { status: "running"; runId: string; accessToken: string }
  | { status: "error"; error: string };

/**
 * A chart's Compare session, cached per analysis so the fork survives the
 * section collapsing/reopening and the panel switching charts (a chart is
 * planned + forked at most once, like a verb run). The identity + the persistent
 * intent (which seeds exist, which are culled, the next colour slot) live here;
 * the realtime branch subscription and ephemeral UI live in CompareSection.
 */
export type CompareSessionState =
  | { status: "starting" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      sessionId: string;
      sessionTag: string;
      accessToken: string;
      base: CompareBase;
      /** Every variant forked so far — identity + colour, before its run reports. */
      seeds: VariantSeed[];
      /** The palette slot the next added variant will own. */
      nextSlot: number;
      /** Branches the analyst has dropped; survivors keep their fixed colours. */
      culled: string[];
    };

interface AnalyzeContextValue {
  /** Every chart analysed this session, in the order they were first opened. */
  analyses: AnalysisSource[];
  /** The analysis the panel is currently showing, or null when closed/empty. */
  current: AnalysisSource | null;
  /** Whether the docked panel is open (pushing the thread aside). */
  isOpen: boolean;
  /** Open the panel on a chart — focuses it if already analysed, else adds it. */
  open: (source: AnalysisSource) => void;
  /** Collapse the panel back to zero width; the analyses survive. */
  close: () => void;
  /** Switch the panel to an already-analysed chart by id. */
  switchTo: (id: string) => void;
  /** The set of sections a given analysis has expanded (preserved per chart). */
  expandedFor: (id: string) => ReadonlySet<SectionKey>;
  /** Expand / collapse a section for a given analysis. */
  toggleSection: (id: string, key: SectionKey) => void;
  /**
   * Start a verb run for a chart if it hasn't been started yet (idempotent). The
   * section calls this on first expand; the cached run is reused on reopen.
   */
  ensureVerbRun: (analysisId: string, verb: VerbKey) => void;
  /** The cached run for a (analysis, verb), or undefined if never expanded. */
  verbRunFor: (analysisId: string, verb: VerbKey) => VerbRunState | undefined;
  /**
   * Plan + fork this chart's Compare session if it hasn't been started
   * (idempotent). The Compare section calls this on first expand; the cached
   * session is reused on reopen and across chart switches.
   */
  ensureCompareRun: (analysisId: string) => void;
  /** The cached Compare session for a chart, or undefined if never expanded. */
  compareSessionFor: (analysisId: string) => CompareSessionState | undefined;
  /** Fork one more variant into the chart's session (specialise SQL + trigger). */
  addCompareVariant: (
    analysisId: string,
    input: { label: string; description?: string; custom?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Drop a branch from the chart's session; survivors' colours are untouched. */
  cullCompareBranch: (analysisId: string, branchId: string) => void;
}

const AnalyzeContext = createContext<AnalyzeContextValue | null>(null);

const runKey = (analysisId: string, verb: VerbKey) => `${analysisId}::${verb}`;

/**
 * "database.table" ids a verb needs as its scope, pulled from the chart's SQL.
 *
 * The Analyze source is a chart, not a discovery finding, so there is no curated
 * scope — we recover it from the FROM/JOIN targets of the query that drew the
 * chart. Qualified `db.table` references are preferred; a bare table name is
 * accepted as a fallback so a run can still start.
 */
function tablesFromSql(sql: string): string[] {
  const out = new Set<string>();
  const qualified = /\b(?:from|join)\s+([A-Za-z_][\w]*\.[A-Za-z_][\w]*)/gi;
  for (const m of sql.matchAll(qualified)) if (m[1]) out.add(m[1]);
  if (out.size === 0) {
    const bare = /\b(?:from|join)\s+([A-Za-z_][\w]*)/gi;
    for (const m of sql.matchAll(bare)) if (m[1]) out.add(m[1]);
  }
  // VerbInput caps scope at 6 tables.
  return [...out].slice(0, 6);
}

/**
 * Session-scoped state for the docked Analyze panel.
 *
 * The panel lives at the chat-page level (above the scrolling thread) so its
 * open/closed state, every chart's expanded sections, and every verb run persist
 * across scrolling and across charts. State is intentionally in-memory only — an
 * analysis is a working surface for the current visit, not something to reload.
 */
export function AnalyzeProvider({ children }: { children: ReactNode }) {
  const [analyses, setAnalyses] = useState<AnalysisSource[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Per-analysis expanded sections, keyed by analysis id, so switching charts
  // restores exactly what that chart had open.
  const [expanded, setExpanded] = useState<Record<string, Set<SectionKey>>>({});
  // Cached verb runs, keyed `${analysisId}::${verb}`.
  const [verbRuns, setVerbRuns] = useState<Record<string, VerbRunState>>({});
  // Cached Compare sessions, keyed by analysis id.
  const [compareSessions, setCompareSessions] = useState<
    Record<string, CompareSessionState>
  >({});

  // Refs mirror state so ensureVerbRun stays stable yet reads fresh values (it is
  // fired from a section's effect, where a stale closure would re-run a verb).
  const analysesRef = useRef(analyses);
  analysesRef.current = analyses;
  const verbRunsRef = useRef(verbRuns);
  verbRunsRef.current = verbRuns;
  const compareSessionsRef = useRef(compareSessions);
  compareSessionsRef.current = compareSessions;

  const open = useCallback((source: AnalysisSource) => {
    setAnalyses((prev) =>
      prev.some((a) => a.id === source.id) ? prev : [...prev, source],
    );
    setCurrentId(source.id);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const switchTo = useCallback((id: string) => {
    setCurrentId(id);
    setIsOpen(true);
  }, []);

  const expandedFor = useCallback(
    (id: string): ReadonlySet<SectionKey> => expanded[id] ?? EMPTY_SET,
    [expanded],
  );

  const toggleSection = useCallback((id: string, key: SectionKey) => {
    setExpanded((prev) => {
      const next = new Set(prev[id] ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, [id]: next };
    });
  }, []);

  const ensureVerbRun = useCallback((analysisId: string, verb: VerbKey) => {
    const key = runKey(analysisId, verb);
    // Idempotent: once a run is starting/running/errored we never re-trigger it.
    if (verbRunsRef.current[key]) return;

    const source = analysesRef.current.find((a) => a.id === analysisId);
    if (!source) return;

    if (!source.sql) {
      setVerbRuns((prev) => ({
        ...prev,
        [key]: { status: "error", error: "This chart has no query to analyse." },
      }));
      return;
    }

    const tables = tablesFromSql(source.sql);
    if (tables.length === 0) {
      setVerbRuns((prev) => ({
        ...prev,
        [key]: {
          status: "error",
          error: "Couldn't identify the source table for this chart.",
        },
      }));
      return;
    }

    setVerbRuns((prev) => ({ ...prev, [key]: { status: "starting" } }));

    const title = source.title || "This chart";
    void startVerbAction({
      verb,
      finding: {
        signal: title,
        finding: title,
        sql: source.sql,
        tables,
        ...(source.chartType ? { chartType: source.chartType } : {}),
      },
      scope: tables,
    }).then((res) => {
      setVerbRuns((prev) => ({
        ...prev,
        [key]: res.ok
          ? {
              status: "running",
              runId: res.runId,
              accessToken: res.accessToken,
            }
          : { status: "error", error: res.error },
      }));
    });
  }, []);

  const verbRunFor = useCallback(
    (analysisId: string, verb: VerbKey): VerbRunState | undefined =>
      verbRuns[runKey(analysisId, verb)],
    [verbRuns],
  );

  const ensureCompareRun = useCallback((analysisId: string) => {
    // Idempotent: once a session is starting/ready/errored we never re-plan it.
    if (compareSessionsRef.current[analysisId]) return;

    const source = analysesRef.current.find((a) => a.id === analysisId);
    if (!source) return;

    if (!source.sql) {
      setCompareSessions((prev) => ({
        ...prev,
        [analysisId]: {
          status: "error",
          error: "This chart has no query to compare.",
        },
      }));
      return;
    }

    setCompareSessions((prev) => ({
      ...prev,
      [analysisId]: { status: "starting" },
    }));

    const question = source.title || "This chart";
    void startCompareAction({ question, sql: source.sql }).then((res) => {
      setCompareSessions((prev) => ({
        ...prev,
        [analysisId]: res.ok
          ? {
              status: "ready",
              sessionId: res.sessionId,
              sessionTag: res.sessionTag,
              accessToken: res.accessToken,
              base: res.base,
              seeds: res.variants,
              nextSlot: res.variants.length,
              culled: [],
            }
          : { status: "error", error: res.error },
      }));
    });
  }, []);

  const compareSessionFor = useCallback(
    (analysisId: string): CompareSessionState | undefined =>
      compareSessions[analysisId],
    [compareSessions],
  );

  const addCompareVariant = useCallback(
    async (
      analysisId: string,
      input: { label: string; description?: string; custom?: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      const session = compareSessionsRef.current[analysisId];
      const source = analysesRef.current.find((a) => a.id === analysisId);
      if (!session || session.status !== "ready" || !source?.sql) {
        return { ok: false, error: "The comparison isn't ready yet." };
      }

      // The slot is claimed now and never re-derived — that is what keeps a
      // culled branch from shifting a survivor's colour. Bump it optimistically.
      const slot = session.nextSlot;
      const change = input.custom ?? input.description ?? input.label;
      setCompareSessions((prev) => {
        const s = prev[analysisId];
        if (!s || s.status !== "ready") return prev;
        return { ...prev, [analysisId]: { ...s, nextSlot: s.nextSlot + 1 } };
      });

      const res = await addCompareVariantAction({
        sessionId: session.sessionId,
        base: session.base,
        sql: source.sql,
        change,
        colorSlot: slot,
      });

      if (res.ok) {
        setCompareSessions((prev) => {
          const s = prev[analysisId];
          if (!s || s.status !== "ready") return prev;
          return { ...prev, [analysisId]: { ...s, seeds: [...s.seeds, res.variant] } };
        });
        return { ok: true };
      }
      return { ok: false, error: res.error };
    },
    [],
  );

  const cullCompareBranch = useCallback(
    (analysisId: string, branchId: string) => {
      setCompareSessions((prev) => {
        const s = prev[analysisId];
        if (!s || s.status !== "ready" || s.culled.includes(branchId)) return prev;
        return { ...prev, [analysisId]: { ...s, culled: [...s.culled, branchId] } };
      });
    },
    [],
  );

  const current = useMemo(
    () => analyses.find((a) => a.id === currentId) ?? null,
    [analyses, currentId],
  );

  const value = useMemo<AnalyzeContextValue>(
    () => ({
      analyses,
      current,
      isOpen,
      open,
      close,
      switchTo,
      expandedFor,
      toggleSection,
      ensureVerbRun,
      verbRunFor,
      ensureCompareRun,
      compareSessionFor,
      addCompareVariant,
      cullCompareBranch,
    }),
    [
      analyses,
      current,
      isOpen,
      open,
      close,
      switchTo,
      expandedFor,
      toggleSection,
      ensureVerbRun,
      verbRunFor,
      ensureCompareRun,
      compareSessionFor,
      addCompareVariant,
      cullCompareBranch,
    ],
  );

  return (
    <AnalyzeContext.Provider value={value}>{children}</AnalyzeContext.Provider>
  );
}

const EMPTY_SET: ReadonlySet<SectionKey> = new Set();

/**
 * Read the Analyze controls. Returns inert no-ops outside a provider so a chart
 * rendered without one (a test, a stray mount) still behaves — its ⌕ button just
 * does nothing rather than throwing.
 */
export function useAnalyze(): AnalyzeContextValue {
  return useContext(AnalyzeContext) ?? FALLBACK;
}

const FALLBACK: AnalyzeContextValue = {
  analyses: [],
  current: null,
  isOpen: false,
  open: () => {},
  close: () => {},
  switchTo: () => {},
  expandedFor: () => EMPTY_SET,
  toggleSection: () => {},
  ensureVerbRun: () => {},
  verbRunFor: () => undefined,
  ensureCompareRun: () => {},
  compareSessionFor: () => undefined,
  addCompareVariant: async () => ({ ok: false, error: "No analysis context." }),
  cullCompareBranch: () => {},
};

"use client";

import { useId, useState } from "react";
import { Badge, Chip, SqlBlock, Tooltip } from "@/components/ui";
import type { BadgeVariant } from "@/components/ui";
import {
  BACKFILL_LABEL,
  canBackfill,
  isDecidable,
  kindLabel,
  type BackfillStatus,
  type FindingStatus,
  type FindingView,
  type OptimizationKind,
} from "../model";

export interface FindingCardProps {
  finding: FindingView;
  /** Ticked for application. Meaningless unless the finding is decidable. */
  selected: boolean;
  onToggle: (selected: boolean) => void;
  /**
   * Ticked to backfill after creating. Only meaningful for a decidable
   * materialized_view finding that is itself selected.
   */
  backfillSelected: boolean;
  onToggleBackfill: (selected: boolean) => void;
  /** The whole report is being applied — selection is frozen. */
  busy?: boolean;
}

/** The Badge hue each backfill state reads in — pending/running sit neutral. */
const BACKFILL_VARIANT: Record<BackfillStatus, BadgeVariant> = {
  pending: "neutral",
  running: "accent",
  done: "good",
  failed: "critical",
  skipped: "neutral",
};

const STATUS_LABEL: Record<FindingStatus, string> = {
  pending: "Pending",
  applied: "Applied",
  failed: "Failed",
  dismissed: "Dismissed",
  advisory: "Rebuild",
};

const STATUS_VARIANT: Record<FindingStatus, BadgeVariant> = {
  pending: "accent",
  applied: "good",
  failed: "critical",
  dismissed: "neutral",
  advisory: "warning",
};

const STATUS_ICON: Partial<Record<FindingStatus, string>> = {
  pending: "◷",
  dismissed: "○",
  advisory: "⚑",
};

/**
 * The kind chip's hue. Appliable kinds each take a fixed series hue; advisory
 * kinds all sit muted, so "can this be done for me?" is legible before the
 * label is read — but the label is always present, so hue is never the only
 * carrier of that distinction.
 *
 * Written out as whole literal class strings rather than composed from a hue
 * variable: Tailwind only emits classes it can see in the source, so an
 * interpolated `text-[var(--series-${n})]` would compile to nothing.
 */
const ADVISORY_CHIP = "text-muted-foreground border-border bg-[var(--raised)]";

const KIND_CHIP: Record<OptimizationKind, string> = {
  materialized_view:
    "text-[var(--series-3)] border-[color-mix(in_srgb,var(--series-3)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-3)_12%,transparent)]",
  projection:
    "text-[var(--series-1)] border-[color-mix(in_srgb,var(--series-1)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-1)_12%,transparent)]",
  skip_index:
    "text-[var(--series-2)] border-[color-mix(in_srgb,var(--series-2)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-2)_12%,transparent)]",
  column_type:
    "text-[var(--series-4)] border-[color-mix(in_srgb,var(--series-4)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-4)_12%,transparent)]",
  column_codec:
    "text-[var(--series-5)] border-[color-mix(in_srgb,var(--series-5)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-5)_12%,transparent)]",
  ttl: "text-[var(--series-7)] border-[color-mix(in_srgb,var(--series-7)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-7)_12%,transparent)]",
  order_by: ADVISORY_CHIP,
  partitioning: ADVISORY_CHIP,
  engine: ADVISORY_CHIP,
  denormalize: ADVISORY_CHIP,
  ingestion: ADVISORY_CHIP,
  query_rewrite: ADVISORY_CHIP,
};

const ROW_SURFACE: Partial<Record<FindingStatus, string>> = {
  applied: "bg-[var(--good-bg)]",
  failed: "bg-[var(--critical-bg)]",
  dismissed: "opacity-60",
};

/**
 * One finding, as a dense row that opens.
 *
 * Deliberately collapsed by default. Every finding carries a rationale, a
 * measurement, a caveat and a block of DDL, and rendering all of that for all
 * of them turned a ten-item report into several screens of scrolling — so the
 * shape of the report (how much, how bad, where) was the one thing you could
 * not see. Collapsed, the whole report fits on a screen and the detail is one
 * click away on the row you actually care about.
 *
 * The collapsed row still carries what a decision needs: severity by group,
 * kind, table, and the estimate. Nothing that changes the meaning of the tick
 * box is hidden behind the disclosure.
 */
export function FindingCard({
  finding,
  selected,
  onToggle,
  backfillSelected,
  onToggleBackfill,
  busy = false,
}: FindingCardProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { kind, status, targetTable, backfillStatus } = finding;
  const decidable = isDecidable(status);
  /** The reader can only offer a backfill while the MV is still pending. */
  const backfillOffered = canBackfill(finding);

  return (
    <div
      className={`overflow-hidden rounded-[var(--r-lg)] border ${
        selected && decidable
          ? "border-[var(--border-accent)]"
          : "border-border"
      } bg-card ${ROW_SURFACE[status] ?? ""}`}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {decidable ? (
          <input
            type="checkbox"
            checked={selected}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Apply: ${finding.title}`}
            className="size-[15px] shrink-0 accent-[var(--brand)]"
          />
        ) : (
          <span className="size-[15px] shrink-0" aria-hidden="true" />
        )}

        <Chip
          label={kindLabel(kind)}
          title={kindLabel(kind)}
          className={`shrink-0 ${KIND_CHIP[kind]}`}
        />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
            {finding.title}
          </span>
          {/* The meta (table + estimate) TRUNCATES when the card is narrow, so it
              yields space rather than pushing the status/chevron off the clipped
              card edge. */}
          <span className="hidden min-w-0 shrink truncate font-mono text-[10.5px] text-muted-foreground min-[620px]:block">
            {targetTable}
          </span>
          {finding.estimate ? (
            <span className="hidden min-w-0 shrink truncate font-mono text-[10.5px] tabular-nums text-[var(--good)] min-[820px]:block">
              {finding.estimate}
            </span>
          ) : null}
          {/* Status + backfill + chevron are pinned right and never shrink, so the
              "Applied"/"Failed" badge stays visible however tight the row gets.
              The backfill is tracked apart from the finding's status — an applied
              MV can still be backfilling — so it gets its own chip. */}
          <span className="flex shrink-0 items-center gap-2">
            {status !== "pending" ? (
              <Badge variant={STATUS_VARIANT[status]} icon={STATUS_ICON[status]}>
                {STATUS_LABEL[status]}
              </Badge>
            ) : null}
            {backfillStatus ? (
              <Badge
                variant={BACKFILL_VARIANT[backfillStatus]}
                icon={backfillStatus === "running" ? "◍" : undefined}
              >
                {BACKFILL_LABEL[backfillStatus]}
              </Badge>
            ) : null}
            <span
              aria-hidden="true"
              className={`text-[10px] text-muted-foreground transition-transform duration-[var(--motion-fast)] ${
                open ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
          </span>
        </button>
      </div>

      {open ? (
        <div id={detailId} className="border-t border-[var(--border-subtle)]">
          <div className="px-3 py-2.5">
            <p className="m-0 text-[12.5px] leading-[1.55] text-[var(--text-secondary)] [text-wrap:pretty]">
              {finding.rationale}
            </p>

            {finding.evidence ? (
              <div className="mt-2.5 rounded-[var(--r-sm)] border-l-2 border-[var(--border-strong)] bg-[var(--raised)] px-2.5 py-1.5 font-mono text-[11px] leading-[1.5] text-[var(--text-secondary)]">
                {finding.evidence}
              </div>
            ) : null}

            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
              <span>{targetTable}</span>
              <span aria-hidden="true">·</span>
              <Tooltip label="Best-practice rule this cites">
                <span>{finding.ruleId}</span>
              </Tooltip>
              {finding.estimate ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums text-[var(--good)]">
                    {finding.estimate}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          {finding.caveat ? (
            <div className="mx-3 mb-2.5 rounded-[var(--r-md)] border border-[var(--warning-border)] bg-[var(--warning-bg)] px-2.5 py-2 text-[11.5px] leading-[1.5] text-[var(--warning)]">
              {finding.caveat}
            </div>
          ) : null}

          {/* Advisory findings carry the migration in place of a tick box — the
              whole point is that there is nothing to press. */}
          {finding.migration ? (
            <div className="mx-3 mb-2.5 rounded-[var(--r-md)] border border-border bg-[var(--raised)] px-2.5 py-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                How to fix it
              </div>
              <div className="text-[12px] leading-[1.55] text-[var(--text-secondary)] [text-wrap:pretty]">
                {finding.migration}
              </div>
            </div>
          ) : null}

          {finding.error ? (
            <div
              role="alert"
              className="mx-3 mb-2.5 break-words rounded-[var(--r-md)] border border-[var(--critical-border)] bg-[var(--critical-bg)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-[var(--critical)]"
            >
              {finding.error}
            </div>
          ) : null}

          {/* A materialized view only captures rows inserted after it exists, so
              on a static dataset its target stays empty until it is backfilled.
              Opt-in, and only meaningful while the view itself is ticked to be
              created — so disabled when the finding is unselected. */}
          {backfillOffered ? (
            <label
              className={`mx-3 mb-2.5 flex items-start gap-2 rounded-[var(--r-md)] border border-border bg-[var(--raised)] px-2.5 py-2 text-[12px] leading-[1.5] ${
                selected
                  ? "cursor-pointer text-[var(--text-secondary)]"
                  : "cursor-not-allowed text-muted-foreground opacity-60"
              }`}
            >
              <input
                type="checkbox"
                checked={backfillSelected && selected}
                disabled={busy || !selected}
                onChange={(e) => onToggleBackfill(e.target.checked)}
                className="mt-[2px] size-[14px] shrink-0 accent-[var(--brand)]"
              />
              <span>
                <span className="text-[var(--text)]">
                  Backfill existing rows after creating
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground [text-wrap:pretty]">
                  Replays the source table through the view once, so the target
                  is not empty. Heavy on a large table; runs after the view is
                  created.
                </span>
              </span>
            </label>
          ) : null}

          {finding.sql ? (
            <SqlBlock
              sql={finding.sql}
              summary="SQL"
              className="rounded-none border-x-0 border-b-0"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

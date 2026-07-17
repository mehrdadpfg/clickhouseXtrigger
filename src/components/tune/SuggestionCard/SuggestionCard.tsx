"use client";

import type { ReactNode } from "react";
import { Badge, Button, Card, Chip, SqlBlock } from "@/components/ui";
import type { BadgeVariant } from "@/components/ui";
import type { CardTone } from "@/components/ui";
import {
  kindLabel,
  type SuggestionKind,
  type SuggestionStatus,
  type SuggestionView,
} from "../model";

export interface SuggestionCardProps {
  suggestion: SuggestionView;
  /** Approve (true) or dismiss (false). Rejected promises surface as an error line. */
  onDecide: (approved: boolean) => void;
  /** A decision is in flight for this card. */
  busy?: boolean;
}

/** The status pill in the header — reserved status colour, always with a word. */
const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending: "Pending approval",
  applied: "Applied",
  failed: "Failed",
  dismissed: "Dismissed",
};

/** Status maps onto the shared Badge variants; the label always carries meaning. */
const STATUS_VARIANT: Record<SuggestionStatus, BadgeVariant> = {
  pending: "accent",
  applied: "good",
  failed: "critical",
  dismissed: "neutral",
};

/** Only where the variant's default glyph differs from the design's status icon. */
const STATUS_ICON: Partial<Record<SuggestionStatus, ReactNode>> = {
  pending: "◷",
  dismissed: "○",
};

/** The card border (and, for terminal states, a faint tint) signals the status. */
const STATUS_TONE: Record<SuggestionStatus, CardTone> = {
  pending: "accent",
  applied: "good",
  failed: "critical",
  dismissed: "neutral",
};

const STATUS_SURFACE: Partial<Record<SuggestionStatus, string>> = {
  applied: "bg-[var(--good-bg)]",
  failed: "bg-[var(--critical-bg)]",
  dismissed: "opacity-70",
};

/** MV vs PROJECTION — distinguished by a fixed, labelled series hue. */
const KIND_CHIP: Record<SuggestionKind, string> = {
  materialized_view:
    "text-[var(--series-3)] border-[color-mix(in_srgb,var(--series-3)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-3)_12%,transparent)]",
  projection:
    "text-[var(--series-1)] border-[color-mix(in_srgb,var(--series-1)_45%,transparent)] bg-[color-mix(in_srgb,var(--series-1)_12%,transparent)]",
};

export function SuggestionCard({
  suggestion,
  onDecide,
  busy = false,
}: SuggestionCardProps) {
  const { kind, name, title, rationale, status } = suggestion;
  const pending = status === "pending";

  return (
    <Card
      tone={STATUS_TONE[status]}
      padding="none"
      clip
      className={STATUS_SURFACE[status]}
    >
      <div className="border-b border-border px-[15px] py-[13px]">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Chip
            label={kindLabel(kind)}
            title={kindLabel(kind)}
            className={KIND_CHIP[kind]}
          />
          <Badge variant={STATUS_VARIANT[status]} icon={STATUS_ICON[status]}>
            {STATUS_LABEL[status]}
          </Badge>
          <span className="ml-auto max-w-[55%] text-right font-mono text-[11px] tabular-nums text-[var(--good)]">
            {suggestion.estSpeedup}
          </span>
        </div>

        <div className="break-words font-mono text-[13px] tabular-nums text-[var(--text)]">
          {name}
        </div>
        <div className="mt-[5px] text-[12.5px] leading-[1.45] text-[var(--text-secondary)]">
          {title !== name ? title : rationale}
        </div>
        {title !== name ? (
          <div className="mt-1 text-[12px] leading-[1.45] text-muted-foreground">
            {rationale}
          </div>
        ) : null}
      </div>

      <div className="flex items-center px-[15px] py-2.5">
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          covers {suggestion.questionsCovered} question
          {suggestion.questionsCovered === 1 ? "" : "s"} · {suggestion.estStorage}{" "}
          · on {suggestion.targetTable}
        </span>
      </div>

      {suggestion.error ? (
        <div
          role="alert"
          className="mx-[15px] mb-2.5 break-words rounded-[var(--r-md)] border border-[var(--critical-border)] bg-[var(--critical-bg)] px-[11px] py-2 font-mono text-[11px] leading-[1.5] text-[var(--critical)]"
        >
          {suggestion.error}
        </div>
      ) : null}

      {pending ? (
        <div className="flex gap-2 px-[15px] pb-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onDecide(true)}
            disabled={busy}
          >
            {busy ? "Working…" : "Approve & create"}
          </Button>
          <Button size="sm" onClick={() => onDecide(false)} disabled={busy}>
            Dismiss
          </Button>
        </div>
      ) : null}

      <SqlBlock
        sql={suggestion.sql}
        summary={`SQL — ${kindLabel(kind).toLowerCase()}`}
        className="rounded-none border-x-0 border-b-0"
      />
    </Card>
  );
}

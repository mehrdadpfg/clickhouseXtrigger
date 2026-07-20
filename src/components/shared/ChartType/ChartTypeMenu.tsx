"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaChart,
  BarChart3,
  LineChart,
  PieChart,
  Shapes,
  Table as TableIcon,
} from "lucide-react";
import type { ChartSpec } from "@/components/ui";
import styles from "./ChartType.module.css";
import { Tooltip } from "@/components/ui";
import { TABLE_VIEW } from "./tableView";

/**
 * Recasting a chart to another type, shared by the thread tile and the
 * workspace.
 *
 * It lived inside Artifacts, so the workspace — the surface actually meant for
 * working on a chart — could only toggle chart/table. One implementation now,
 * with the trigger's styling passed in, because the two surfaces sit on
 * different chrome: a 26px icon button on a tile, a labelled button in the
 * canvas toolbar.
 */

export { TABLE_VIEW };

const CHART_TYPES: { type: string; label: string; Icon: typeof BarChart3 }[] = [
  { type: "Bar Chart", label: "Bar", Icon: BarChart3 },
  { type: "Line Chart", label: "Line", Icon: LineChart },
  { type: "Area Chart", label: "Area", Icon: AreaChart },
  { type: "Pie Chart", label: "Pie", Icon: PieChart },
  { type: TABLE_VIEW, label: "Table", Icon: TableIcon },
];

/**
 * Recast a chart to a different type without re-asking the agent: pull a category
 * and a measure from whatever channels it uses, then slot them into the target
 * family's channels — x/y for a cartesian chart, color/size for a part-to-whole.
 */
export function recast(spec: ChartSpec, target: string): ChartSpec {
  const e = spec.encodings;
  const category = e["x"] ?? e["color"] ?? e["y"] ?? Object.values(e)[0] ?? "";
  const measure =
    e["y"] ??
    e["size"] ??
    e["value"] ??
    Object.values(e).find((f) => f !== category) ??
    category;
  const series = e["x"] && e["color"] ? e["color"] : e["group"];
  const partToWhole = /pie|donut|doughnut|rose|funnel/i.test(target);
  const encodings: Record<string, string> = partToWhole
    ? { color: category, size: measure }
    : { x: category, y: measure };
  if (!partToWhole && series) encodings["color"] = series;
  return { ...spec, chartType: target, encodings };
}

/** Small menu on a chart to recast it as bar/line/area/pie/table, client-side. */
export function ChartTypeMenu({
  current,
  allowPie,
  onPick,
  originalType,
  triggerClassName,
  showLabel = false,
}: {
  current: string;
  allowPie: boolean;
  onPick: (type: string) => void;
  /**
   * The type the agent drew, which may be one of the ~25 this menu can't
   * produce. Kept in the list so recasting a Sankey to a bar is reversible
   * without re-asking — derived from `current` it would vanish on first recast.
   */
  originalType?: string;
  /** The host's own button chrome — tile tool vs canvas toolbar button. */
  triggerClassName?: string;
  /** The canvas has room to name the current type; a 26px tile button doesn't. */
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const recastable = CHART_TYPES.filter((o) => o.type !== "Pie Chart" || allowPie);

  /**
   * The agent draws ~30 chart types; only five are recast targets. A chart
   * outside that set — a Sankey, a boxplot, a treemap — used to fall through
   * `find() ?? opts[0]` and get LABELLED BAR, which is simply wrong about what
   * the reader is looking at.
   *
   * So the chart's own type leads the list when it isn't already a target. It
   * is the current selection and a way back: recast to a bar, change your mind,
   * return to the Sankey without re-asking the agent.
   */
  const own = originalType ?? current;
  const foreign =
    own && own !== TABLE_VIEW && !CHART_TYPES.some((o) => o.type === own)
      ? [{ type: own, label: own.replace(/ Chart$/, ""), Icon: Shapes }]
      : [];

  const opts = [...foreign, ...recastable];
  const Cur = (opts.find((o) => o.type === current) ?? opts[0]!).Icon;

  return (
    <div className={styles.typeMenuWrap} ref={ref}>
      <Tooltip label="Change chart type">
        <button
          type="button"
          className={triggerClassName}
          aria-label="Change chart type"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Cur size={15} strokeWidth={2} aria-hidden="true" />
          {showLabel ? (opts.find((o) => o.type === current) ?? opts[0]!).label : null}
        </button>
      </Tooltip>
      {open ? (
        <div className={styles.typeMenu} role="menu">
          {opts.map(({ type, label, Icon }) => (
            <button
              key={type}
              type="button"
              role="menuitemradio"
              aria-checked={type === current}
              className={`${styles.typeItem} ${type === current ? styles.typeItemActive : ""}`}
              onClick={() => {
                onPick(type);
                setOpen(false);
              }}
            >
              <Icon size={14} strokeWidth={2} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}


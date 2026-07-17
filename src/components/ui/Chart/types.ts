/* The declarative spec the agent emits. Deliberately small: a chart is a kind,
   some named series, and two axis descriptions. Everything else is a default. */

export type ChartKind = "line" | "area" | "bar" | "barh" | "scatter";

/** A category label, a timestamp (ms), or a numeric measure. */
export type ChartX = string | number;

export interface ChartPoint {
  x: ChartX;
  /** null is a *gap*, not a zero: lines break across it, marks are skipped. */
  y: number | null;
}

export interface ChartSeries {
  /** The entity's name. Identity — carried into legend, labels and table. */
  name: string;
  points: ChartPoint[];
  /**
   * The 0-based palette slot this series owns.
   *
   * Colour follows the ENTITY, not its rank. A caller that filters or re-sorts
   * series must pin a slot per entity, so dropping "LGA" never repaints "JFK".
   * Defaults to the array position, which is correct only while the array is
   * stable. Slots at or past 8 fold into "Other" — never a generated hue.
   */
  colorSlot?: number;
}

export interface ChartXAxis {
  label?: string;
  format?: (value: ChartX) => string;
}

export interface ChartYAxis {
  label?: string;
  format?: (value: number) => string;
}

export interface ChartSpec {
  kind: ChartKind;
  series: ChartSeries[];
  /** Names what is plotted. With one series this stands in for the legend. */
  title: string;
  x?: ChartXAxis;
  y?: ChartYAxis;
}

export interface ChartProps extends ChartSpec {
  /** Plot height in px, excluding the axis band. */
  height?: number;
  className?: string;
}

/** A series after palette resolution. */
export interface ResolvedSeries {
  name: string;
  points: ChartPoint[];
  /** Always a var() reference — no chart ever holds a hex. */
  color: string;
  /** -1 once folded into "Other". */
  slot: number;
  isOther: boolean;
}

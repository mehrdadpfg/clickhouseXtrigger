/* Compare — the fork / multiverse surface. Domain composition: it knows about
   variants and branches, and is driven by a CompareView the route keeps in step
   with the durable compare-branch runs. */

export { CompareSidebar } from "./CompareSidebar/CompareSidebar";
export { BranchTile } from "./BranchTile/BranchTile";
export { Sparkline } from "./Sparkline/Sparkline";
export type { SparklineProps, SparklinePoint } from "./Sparkline/Sparkline";
export {
  branchColor,
  formatDelta,
  formatMetric,
  hasAnyData,
  sharedScaleLabel,
  sharedXCount,
  sharedYScale,
} from "./model";
export type { BranchView, CompareView, VariantSuggestion } from "./model";

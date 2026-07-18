/* Compare — the fork / multiverse surface. Domain composition: it knows about
   variants and branches, and is driven by a CompareView the host keeps in step
   with the durable compare-branch runs. The live wiring now lives in the docked
   Analyze panel's "Compare variants" section (CompareSection); this module
   exposes the prop-driven body and the pure view model it renders. */

export { CompareBody } from "./CompareSidebar/CompareBody";
export { BranchTile } from "./BranchTile/BranchTile";
export { Sparkline } from "./Sparkline/Sparkline";
export type { SparklineProps, SparklinePoint } from "./Sparkline/Sparkline";
export {
  branchColor,
  formatDelta,
  formatMetric,
  hasAnyData,
  runStatusToBranchStatus,
  sharedScaleLabel,
  sharedXCount,
  sharedYScale,
} from "./model";
export type { BranchView, CompareView, VariantSuggestion } from "./model";

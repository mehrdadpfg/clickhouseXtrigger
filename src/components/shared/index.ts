/**
 * Composite components used by 2+ surfaces (boards, chat, watch…).
 *
 * Three homes, and the difference decides which you reach for:
 *   - ui/       — design-system PRIMITIVES. No domain knowledge: they take
 *                 labels and numbers, never watchers or queries. Reusable
 *                 anywhere, including outside this app.
 *   - shared/   — composites that DO know this app's domain (chart specs,
 *                 chat rows) and are used by more than one surface. They may
 *                 import from ui/ and from domain types, but a feature folder
 *                 must never import from another feature folder — that is the
 *                 whole reason these live here instead of in chat/.
 *   - <feature>/ — anything used by exactly one surface stays in that surface's
 *                 folder (boards/, chat/, watch/). The moment a second surface
 *                 needs it, it graduates to shared/ (or ui/ if it sheds its
 *                 domain knowledge on the way).
 */

export * from "./ChartStudio";
export * from "./ChartType";
export * from "./HistorySidebar";
export * from "./PushPanel";

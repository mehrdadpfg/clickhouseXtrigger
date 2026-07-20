import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Ease the board's tiles to their new geometry after a reorder or a resize,
 * instead of letting them snap.
 *
 * WHY a hook and not a CSS transition. The two gestures this smooths both change
 * layout in ways CSS cannot transition. A resize writes `grid-column: span N` on
 * one tile, and `grid-column` is not an animatable property — `transition:
 * grid-column` is simply inert. A reorder (or the reflow a resize forces on its
 * neighbours) moves tiles that had NO property change of their own to transition:
 * they shift because the grid re-placed them, not because anything about them
 * animated. FLIP is the way around both. Let React commit the new layout, read
 * where every tile ended up (Last), compare with where it was (First), apply the
 * transform that inverts that difference so the tile still LOOKS unmoved, then
 * drop the transform on the next frame so it glides home under one transition.
 *
 * WHY First is remembered, not measured on the spot. This runs as a layout
 * effect, so by the time it fires the browser has already reflowed to the new
 * layout and the old box is gone — the only record of where a tile was is the box
 * we stored last run. Hence `first`, carried across renders.
 *
 * WHY the rendered box is preferred as the start point. Drag fast enough to cross
 * two column boundaries inside one 180ms glide and the second layout change lands
 * mid-animation. Snapping the tile back to its stale settled origin would read as
 * a stutter; instead, while a glide is still visibly in flight we start the next
 * one from the tile's RENDERED box (transform and all), so the eye sees one
 * continuous move rather than a rewind.
 *
 * Only translate and a horizontal scale are applied. Width is the dimension a
 * resize changes, so scaleX carries that ease; height is left to snap because
 * scaling a tile vertically would visibly squash the chart or table inside it for
 * no gain — reorder keeps width and height equal, so it comes out as pure
 * translate. `prefers-reduced-motion` is honoured by leaving every tile at its
 * settled position and applying no transform at all (the app's global reduced-
 * motion reset would collapse the transition anyway, but returning early also
 * spares the work and any single-frame inversion flash).
 */
export function useGridFlip(
  gridRef: RefObject<HTMLDivElement | null>,
  deps: unknown[],
) {
  // Where each tile was laid out at the end of the previous pass, keyed by id.
  const first = useRef<Map<string, DOMRect>>(new Map());
  const raf = useRef(0);
  const sweep = useRef(0);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    // Only real tiles carry data-tile-id; the guide overlay deliberately does
    // not, so it never gets measured or transformed.
    const tiles = (Array.from(grid.children) as HTMLElement[]).filter(
      (el) => el.dataset.tileId,
    );

    // Rendered boxes first — these still include any transform from a glide that
    // has not finished, which is exactly the honest start point for continuing
    // it. Then strip transforms so the next read is the true settled layout.
    const rendered = new Map<string, DOMRect>();
    for (const el of tiles) {
      rendered.set(el.dataset.tileId!, el.getBoundingClientRect());
    }
    for (const el of tiles) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    const last = new Map<string, DOMRect>();
    for (const el of tiles) {
      last.set(el.dataset.tileId!, el.getBoundingClientRect());
    }

    const prev = first.current;
    first.current = last;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const movers: HTMLElement[] = [];
    for (const el of tiles) {
      const id = el.dataset.tileId!;
      const to = last.get(id)!;
      const settled = prev.get(id);
      // No record of a previous position — a tile that just mounted (board load,
      // a pin from chat). It lands on its own, nothing to glide from.
      if (!settled) continue;

      const shown = rendered.get(id)!;
      // A glide still in flight leaves the rendered box off its settled home;
      // start the next move from there so it reads as continuous. Otherwise the
      // tile is at rest and its previous layout is the true origin.
      const midFlight =
        Math.abs(shown.left - to.left) > 0.5 ||
        Math.abs(shown.top - to.top) > 0.5 ||
        Math.abs(shown.width - to.width) > 0.5;
      const from = midFlight ? shown : settled;

      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const sx = to.width > 0 ? from.width / to.width : 1;
      if (
        Math.abs(dx) < 0.5 &&
        Math.abs(dy) < 0.5 &&
        Math.abs(sx - 1) < 0.005
      ) {
        continue;
      }

      el.style.transformOrigin = "0 0";
      el.style.transform = `translate(${dx}px, ${dy}px) scaleX(${sx})`;
      movers.push(el);
    }

    // Every tile got `transition: none` up front so stripping its transform did
    // not animate. Only the movers keep an override past this point (their real
    // transition is set next frame); every other tile must have that override
    // lifted now, or an untouched tile would keep `transition: none` inline and
    // lose its own hover/border eases for good.
    const still = new Set(movers);
    for (const el of tiles) {
      if (still.has(el)) continue;
      el.style.transition = "";
      // `transform-origin` is inert without a transform, but clear it too so a
      // tile that moved in an earlier pass leaves nothing inline behind.
      el.style.transformOrigin = "";
    }
    if (movers.length === 0) return;

    // One frame at the inverted position, then release it. requestAnimationFrame
    // rather than a reflow read so the "none" transition above is committed
    // before the real one replaces it — otherwise the browser coalesces both and
    // there is nothing to transition from.
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      for (const el of movers) {
        el.style.transition = "transform var(--motion-base) var(--ease-in-out)";
        el.style.transform = "";
      }
    });

    // Return each settled mover to its stylesheet-driven self. `transitionend` is
    // the usual trigger, but it does not fire when a fast follow-up drag cancels
    // the glide, so a timeout past one glide's length is the backstop: without it
    // a just-moved tile would keep an inline `transition: transform` that shadows
    // its own hover/border eases until the next reorder. Only clear a tile that
    // is actually at rest, so an animation still running is left alone. Later
    // passes retire their predecessors (a mover that stops moving is reset as a
    // non-mover above), so tracking just the newest sweep is enough.
    const settle = (el: HTMLElement) => {
      if (el.style.transform) return;
      el.style.transition = "";
      el.style.transformOrigin = "";
      el.removeEventListener("transitionend", onEnd);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === "transform") settle(e.currentTarget as HTMLElement);
    };
    for (const el of movers) el.addEventListener("transitionend", onEnd);
    window.clearTimeout(sweep.current);
    sweep.current = window.setTimeout(() => {
      for (const el of movers) settle(el);
    }, 280);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(sweep.current);
    },
    [],
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Measures the container so the SVG can be drawn at 1:1 device pixels.
 *
 * The alternative — a fixed viewBox scaled by CSS — scales the *text* with it,
 * so a 9px axis label rendered into a 760-wide viewBox at 600px CSS width comes
 * out at 7.1px. The brief requires legibility at ~600px, so measure instead.
 *
 * Seeded at the reading column's width so first paint is close and there is no
 * visible reflow.
 */
export function useSize<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = entry.contentRect.width;
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, width } as const;
}

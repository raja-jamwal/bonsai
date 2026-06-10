// Fixed-position math for the portaled fork-point menu. Pure (no React/DOM
// runtime) so it's unit-testable; MessageStream feeds it the chip's viewport
// rect + window.innerHeight. See test/forkMenuPosition.test.ts.
import type { CSSProperties } from 'react';

/** The open fork chip's viewport geometry: horizontal center + top/bottom edges. */
export interface ForkAnchor {
  cx: number;
  top: number;
  bottom: number;
}

/** Gap in px between the chip and the menu. */
const GAP = 6;
/** Min room below the chip before we flip the menu upward. */
const FLIP_THRESHOLD = 200;

/**
 * `position: fixed` style for the menu given the chip rect and viewport height.
 * Opens downward from the chip's bottom edge, flipping to anchor above the chip's
 * top edge when there isn't ~200px of room below (the chip usually sits just
 * above the composer). `left` is the chip center; CSS centers the menu on it via
 * translateX(-50%). Because it's fixed + portaled to <body>, it escapes the
 * stream's overflow clip.
 */
export function forkMenuStyle(anchor: ForkAnchor, viewportHeight: number): CSSProperties {
  const openUp = viewportHeight - anchor.bottom < FLIP_THRESHOLD;
  return openUp
    ? { left: anchor.cx, bottom: viewportHeight - anchor.top + GAP }
    : { left: anchor.cx, top: anchor.bottom + GAP };
}

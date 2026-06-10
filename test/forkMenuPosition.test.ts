// Unit tests for forkMenuStyle — the fixed-position math for the portaled
// fork-point menu (down by default, flip up near the viewport bottom). Pure
// function; the CSSProperties import is type-only, so no React/DOM runtime.
import { describe, it, expect } from 'vitest';
import { forkMenuStyle, type ForkAnchor } from '../src/renderer/components/forkMenuPosition';

const VH = 800;

describe('forkMenuStyle', () => {
  it('opens downward from the chip bottom when there is room below', () => {
    const anchor: ForkAnchor = { cx: 640, top: 300, bottom: 320 };
    const style = forkMenuStyle(anchor, VH);
    expect(style).toEqual({ left: 640, top: 326 }); // bottom + 6 gap
    expect(style).not.toHaveProperty('bottom');
  });

  it('flips upward (anchors above the chip top) when the chip is near the bottom', () => {
    // chip bottom 780 → only 20px of room below in an 800px viewport → flip.
    const anchor: ForkAnchor = { cx: 500, top: 760, bottom: 780 };
    const style = forkMenuStyle(anchor, VH);
    expect(style).toEqual({ left: 500, bottom: VH - 760 + 6 }); // 46
    expect(style).not.toHaveProperty('top');
  });

  it('left is always the chip center (menu is centered on it via translateX)', () => {
    expect(forkMenuStyle({ cx: 123, top: 10, bottom: 30 }, VH).left).toBe(123);
    expect(forkMenuStyle({ cx: 999, top: 790, bottom: 798 }, VH).left).toBe(999);
  });

  it('flip boundary: just under 200px of room flips, exactly 200px stays down', () => {
    // room = VH - bottom; threshold is `< 200`.
    expect(forkMenuStyle({ cx: 0, top: 580, bottom: 601 }, VH)).toHaveProperty('bottom'); // room 199 → up
    expect(forkMenuStyle({ cx: 0, top: 580, bottom: 600 }, VH)).toHaveProperty('top'); // room 200 → down
  });
});

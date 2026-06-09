// Verifies markdownSanitizeSchema actually strips dangerous HTML while keeping
// the SVG/image/markup we want to render inline. Runs hast-util-sanitize (the
// same engine rehype-sanitize wraps) against parsed HTML — no DOM needed.
import { describe, it, expect } from 'vitest';
import { fromHtml } from 'hast-util-from-html';
import { sanitize } from 'hast-util-sanitize';
import { markdownSanitizeSchema } from '../src/renderer/components/markdownSanitizeSchema';

/* eslint-disable @typescript-eslint/no-explicit-any */
function clean(html: string): any {
  const tree = fromHtml(html, { fragment: true });
  return sanitize(tree, markdownSanitizeSchema as any);
}
function tagNames(node: any, acc: string[] = []): string[] {
  if (node.type === 'element') acc.push(node.tagName);
  for (const c of node.children ?? []) tagNames(c, acc);
  return acc;
}
function find(node: any, tag: string): any {
  if (node.type === 'element' && node.tagName === tag) return node;
  for (const c of node.children ?? []) {
    const r = find(c, tag);
    if (r) return r;
  }
  return null;
}
const propKeys = (node: any): string[] => Object.keys(node?.properties ?? {});

describe('markdownSanitizeSchema', () => {
  it('strips <script> entirely', () => {
    expect(tagNames(clean('<p>hi</p><script>alert(1)</script>'))).not.toContain('script');
  });

  it('strips <iframe>/<object>/<embed>/<foreignObject> (no in-place execution surface)', () => {
    const t = tagNames(
      clean('<iframe src="x"></iframe><object data="x"></object><embed src="x">')
    );
    expect(t).not.toContain('iframe');
    expect(t).not.toContain('object');
    expect(t).not.toContain('embed');
    expect(tagNames(clean('<svg><foreignObject><div>x</div></foreignObject></svg>'))).not.toContain(
      'foreignObject'
    );
  });

  it('removes event handlers and inline style', () => {
    const div = find(clean('<div onclick="evil()" style="position:fixed">x</div>'), 'div');
    expect(div).toBeTruthy();
    expect(propKeys(div).some((k) => /^on/i.test(k))).toBe(false);
    expect(propKeys(div)).not.toContain('style');
  });

  it('drops javascript: URLs but keeps safe links', () => {
    const bad = find(clean('<a href="javascript:alert(1)">x</a>'), 'a');
    expect(bad?.properties?.href).toBeUndefined();
    const good = find(clean('<a href="https://example.com">x</a>'), 'a');
    expect(good?.properties?.href).toBe('https://example.com');
  });

  it('keeps presentational SVG (tags + geometry/paint attributes)', () => {
    const out = clean(
      '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 12h18" stroke="red" stroke-width="2"/></svg>'
    );
    expect(tagNames(out)).toEqual(expect.arrayContaining(['svg', 'path']));
    const svg = find(out, 'svg');
    expect(svg.properties.viewBox).toBe('0 0 24 24');
    const path = find(out, 'path');
    expect(path.properties.d).toBe('M3 12h18');
    expect(path.properties.stroke).toBe('red');
    expect(String(path.properties.strokeWidth)).toBe('2');
  });

  it('keeps <img> but strips its event handlers', () => {
    const img = find(clean('<img src="data:image/png;base64,iVBOR" alt="x" onerror="evil()">'), 'img');
    expect(img).toBeTruthy();
    expect(img.properties.alt).toBe('x');
    expect(propKeys(img).some((k) => /^on/i.test(k))).toBe(false);
  });

  it('keeps the KaTeX / highlight placeholder classes the later plugins consume', () => {
    const math = find(clean('<span class="math math-inline">x</span>'), 'span');
    expect(math.properties.className).toEqual(expect.arrayContaining(['math', 'math-inline']));
    const code = find(clean('<pre><code class="language-python">x</code></pre>'), 'code');
    expect(code.properties.className).toContain('language-python');
  });

  it('does not mutate rehype-sanitize defaultSchema (svg only on our copy)', async () => {
    const { defaultSchema } = await import('rehype-sanitize');
    expect(defaultSchema.tagNames).not.toContain('svg');
    expect(markdownSanitizeSchema.tagNames).toContain('svg');
  });
});

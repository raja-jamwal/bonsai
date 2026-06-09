// Sanitize schema for rendering model-authored HTML/SVG inline (Markdown.tsx).
//
// SECURITY: assistant text is untrusted (it can be prompt-injected by content it
// reads). It is rendered in the MAIN renderer, which — although Electron-sandboxed
// with contextIsolation — still exposes window.api. So raw HTML must be sanitized:
// we start from rehype-sanitize's GitHub-derived defaultSchema (which already
// strips <script>, on* handlers, javascript: URLs, etc.) and extend it ONLY with
// presentational SVG + the class names KaTeX/highlight need. We deliberately do
// NOT allow `style`/`class` on arbitrary elements, <foreignObject>, <iframe>,
// <object>, or event handlers — so inline content can't run JS or overlay the app.
// Interactive code runs in the isolated <iframe> artifact host instead (Artifact.tsx).
import { defaultSchema } from 'rehype-sanitize';

// SVG element names (hast keeps SVG tag casing). foreignObject is intentionally
// excluded — it can embed arbitrary HTML.
const SVG_TAGS = [
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'use',
  'symbol', 'marker', 'clipPath', 'mask', 'pattern', 'title', 'desc',
];

// Presentational SVG attributes (hast camelCases hyphenated names, e.g.
// stroke-width -> strokeWidth). Geometry/paint only — nothing that can script
// or break out of the SVG's box.
const SVG_ATTRS = [
  'xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'transform', 'id',
  'fill', 'fillOpacity', 'fillRule', 'stroke', 'strokeWidth', 'strokeLinecap',
  'strokeLinejoin', 'strokeDasharray', 'strokeDashoffset', 'strokeOpacity',
  'strokeMiterlimit', 'opacity', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'points', 'offset', 'stopColor',
  'stopOpacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'textAnchor',
  'dominantBaseline', 'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing',
  'clipPath', 'clipRule', 'mask', 'markerStart', 'markerMid', 'markerEnd',
  'patternUnits', 'patternTransform', 'href', 'xlinkHref',
];

type Attrs = Record<string, Array<unknown>>;

/** Build the extended schema without mutating rehype-sanitize's exported default. */
function buildSchema() {
  const baseAttrs = (defaultSchema.attributes ?? {}) as Attrs;
  const attributes: Attrs = {};
  for (const [k, v] of Object.entries(baseAttrs)) attributes[k] = [...v];

  // Presentational attributes on every SVG element.
  for (const tag of SVG_TAGS) {
    attributes[tag] = [...(attributes[tag] ?? []), ...SVG_ATTRS];
  }
  // KaTeX leaves <span class="math math-inline"> / <div class="math math-display">
  // placeholders that rehype-katex (which runs AFTER sanitize) consumes — keep them.
  attributes.span = [...(attributes.span ?? []), ['className', 'math', 'math-inline', 'math-display']];
  attributes.div = [...(attributes.div ?? []), ['className', 'math', 'math-display']];
  // rehype-highlight reads `language-*` off the source <code> (also after sanitize).
  attributes.code = [...(attributes.code ?? []), ['className', /^language-./]];
  // Allow explicit image sizing (src is already constrained to self/data: by CSP).
  attributes.img = [...(attributes.img ?? []), 'width', 'height'];

  return {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), ...SVG_TAGS],
    attributes,
  };
}

export const markdownSanitizeSchema = buildSchema();

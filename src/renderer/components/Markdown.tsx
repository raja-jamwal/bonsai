// Markdown.tsx — rich message rendering: GitHub-flavored markdown, KaTeX math
// ($…$ / $$…$$ / \(…\) / \[…\]), syntax-highlighted fenced code, styled inline
// code, and SANITIZED inline HTML/SVG/images.
//
// Security: assistant text is untrusted. We allow raw HTML (rehype-raw) but run
// it through rehype-sanitize with markdownSanitizeSchema, which strips <script>,
// on* handlers, javascript: URLs, <iframe>/<object>/<foreignObject>, and inline
// style/class — so inline content can render SVG/images/tables but can't execute
// JS or overlay the app. Interactive code (HTML/React apps) is NOT run here; it
// goes to the isolated <iframe> artifact host (Artifact.tsx).
//
// Plugin ORDER matters: rehype-raw reparses HTML first, then sanitize cleans it,
// THEN rehype-katex / rehype-highlight inject their (trusted) output — which is
// why sanitize must run before them and why the schema preserves the math/
// language-* placeholder classes those two plugins consume. `throwOnError: false`
// keeps partial math during streaming from crashing the render.
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import { markdownSanitizeSchema } from './markdownSanitizeSchema';

const REMARK = [remarkGfm, remarkMath];
const REHYPE = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false }],
  rehypeHighlight,
];

/**
 * Normalize the LaTeX delimiters LLMs commonly emit (`\(…\)`, `\[…\]`) into the
 * `$…$` / `$$…$$` that remark-math understands. Done outside fenced code so we
 * don't rewrite literal backslashes inside code samples.
 */
function normalizeMath(src: string): string {
  const parts = src.split(/(```[\s\S]*?```|`[^`]*`)/g);
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // code span/fence — leave untouched
      return (
        seg
          // \[ … \] -> block display math (own lines so remark-math sees a block)
          .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x: string) => `\n\n$$\n${x.trim()}\n$$\n\n`)
          // \( … \) -> inline math
          .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x: string) => `$${x.trim()}$`)
          // single-line $$ … $$ -> block form, so it renders in DISPLAY mode
          // (true display style: limits under ∑/∫, centered). A $$ already in
          // block form starts with a newline and is left untouched.
          .replace(
            /\$\$([^\n$][\s\S]*?)\$\$/g,
            (_m, x: string) => `\n\n$$\n${x.trim()}\n$$\n\n`
          )
      );
    })
    .join('');
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rehypePlugins={REHYPE as any}
        // Let raw HTML nodes survive into hast so rehype-raw can reparse them
        // (rehype-sanitize then makes them safe).
        remarkRehypeOptions={{ allowDangerousHtml: true }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}

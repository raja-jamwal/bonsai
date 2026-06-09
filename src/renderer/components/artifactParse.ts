// Pure parsing for interactive artifacts embedded in assistant messages.
//
// Convention (kept intentional so ordinary ```jsx/```html code blocks still
// render as READABLE code, never auto-execute): an artifact is a fenced block
// whose info string's first word is a dedicated artifact language —
//   ```react-app   → a small React component/app (JSX/TSX, mounted)
//   ```html-app    → a self-contained HTML document/fragment (CSS + JS)
// Only CLOSED fences become artifacts; an unterminated fence (mid-stream) stays
// in the markdown segment and renders as a normal code block until it closes.
//
// splitMessage() slices a message into ordered markdown / artifact segments so
// the renderer can show prose with <Markdown> and run code in the isolated
// <iframe> host (Artifact.tsx). This module touches no DOM and is unit-tested.

export type ArtifactKind = 'react' | 'html';

export type MessageSegment =
  | { type: 'markdown'; text: string }
  | { type: 'artifact'; kind: ArtifactKind; code: string };

const LANG_TO_KIND: Record<string, ArtifactKind> = {
  'react-app': 'react',
  'html-app': 'html',
};

// A fenced block at line start whose first info word is an artifact lang.
// Group 1: the lang token. Group 2: the fenced body. Requires a closing fence.
const ARTIFACT_FENCE =
  /(?:^|\n)```(react-app|html-app)[^\n]*\n([\s\S]*?)\n```(?=\n|$)/g;

/** Split a message into ordered markdown + artifact segments. */
export function splitMessage(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  // Reset stateful regex per call.
  ARTIFACT_FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARTIFACT_FENCE.exec(text)) !== null) {
    const kind = LANG_TO_KIND[m[1]];
    // The match may start with the leading \n we allowed; the markdown chunk is
    // everything up to where the actual ``` fence began.
    const fenceStart = m.index + (text[m.index] === '\n' ? 1 : 0);
    const before = text.slice(lastIndex, fenceStart);
    if (before.trim()) segments.push({ type: 'markdown', text: before });
    segments.push({ type: 'artifact', kind, code: m[2] });
    lastIndex = ARTIFACT_FENCE.lastIndex;
  }
  const rest = text.slice(lastIndex);
  if (rest.trim() || segments.length === 0) {
    segments.push({ type: 'markdown', text: rest });
  }
  return segments;
}

/** True if the message contains at least one runnable artifact. */
export function hasArtifact(text: string): boolean {
  ARTIFACT_FENCE.lastIndex = 0;
  return ARTIFACT_FENCE.test(text);
}

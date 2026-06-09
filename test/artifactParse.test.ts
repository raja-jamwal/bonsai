import { describe, it, expect } from 'vitest';
import { splitMessage, hasArtifact } from '../src/renderer/components/artifactParse';

describe('splitMessage', () => {
  it('returns a single markdown segment for plain prose', () => {
    expect(splitMessage('just some **text**')).toEqual([
      { type: 'markdown', text: 'just some **text**' },
    ]);
  });

  it('extracts a react-app fence as an artifact', () => {
    const seg = splitMessage('```react-app\nexport default () => <h1>hi</h1>\n```');
    expect(seg).toEqual([
      { type: 'artifact', kind: 'react', code: 'export default () => <h1>hi</h1>' },
    ]);
  });

  it('keeps prose before and after an artifact in order', () => {
    const seg = splitMessage('Here:\n\n```html-app\n<b>x</b>\n```\n\nDone.');
    expect(seg).toEqual([
      { type: 'markdown', text: 'Here:\n\n' },
      { type: 'artifact', kind: 'html', code: '<b>x</b>' },
      { type: 'markdown', text: '\n\nDone.' },
    ]);
  });

  it('handles multiple artifacts', () => {
    const seg = splitMessage('```react-app\nA\n```\n```html-app\nB\n```');
    expect(seg.filter((s) => s.type === 'artifact')).toEqual([
      { type: 'artifact', kind: 'react', code: 'A' },
      { type: 'artifact', kind: 'html', code: 'B' },
    ]);
  });

  it('does NOT treat ordinary ```jsx / ```html code blocks as artifacts', () => {
    const seg = splitMessage('```jsx\nconst x = <div/>\n```\n```html\n<div></div>\n```');
    expect(seg).toHaveLength(1);
    expect(seg[0].type).toBe('markdown');
  });

  it('leaves an unterminated artifact fence as markdown (mid-stream)', () => {
    const seg = splitMessage('```react-app\nexport default () => <h1>partial');
    expect(seg).toHaveLength(1);
    expect(seg[0]).toMatchObject({ type: 'markdown' });
  });

  it('preserves code content verbatim, including blank lines', () => {
    const code = 'const a = 1;\n\nfunction f() {\n  return a;\n}';
    const seg = splitMessage('```react-app\n' + code + '\n```');
    expect(seg[0]).toEqual({ type: 'artifact', kind: 'react', code });
  });
});

describe('hasArtifact', () => {
  it('detects a closed artifact fence', () => {
    expect(hasArtifact('```react-app\nx\n```')).toBe(true);
    expect(hasArtifact('```html-app\nx\n```')).toBe(true);
  });
  it('is false for prose and ordinary code blocks', () => {
    expect(hasArtifact('no artifacts here')).toBe(false);
    expect(hasArtifact('```js\nconsole.log(1)\n```')).toBe(false);
    expect(hasArtifact('```react-app\nunterminated')).toBe(false);
  });
});

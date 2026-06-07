// Tests for the NDJSON stream parser (CL-5, CL-6).
// Drives the real captured fixture through StreamParser two ways — all at once
// and split into arbitrary mid-line chunks — and asserts the parser is robust to
// chunk boundaries (it must buffer partial lines, NF-2) and never throws on bad
// JSON (CL-5: unknown/malformed lines are ignored, not fatal).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StreamParser, type ParseEmit } from '../src/main/claude/parser';

// Resolve the fixture relative to this test file so the suite is cwd-independent.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'stream_capture.ndjson');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

/** Collect the full emit sequence for a given feed strategy. */
function emitsForChunks(chunks: string[]): ParseEmit[] {
  const parser = new StreamParser();
  const out: ParseEmit[] = [];
  for (const chunk of chunks) out.push(...parser.feed(chunk));
  out.push(...parser.end());
  return out;
}

/** Split a string into arbitrary, deliberately uneven, mid-line chunks. */
function splitMidline(s: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}

/** Shared assertions over a parsed emit stream — CL-5/CL-6 expectations. */
function assertFixtureEmits(emits: ParseEmit[]): void {
  // (CL-5) deltas concatenate to the assistant text 'PONG'.
  const deltaText = emits
    .filter((e): e is Extract<ParseEmit, { kind: 'delta' }> => e.kind === 'delta')
    .map((e) => e.text)
    .join('');
  expect(deltaText).toBe('PONG');

  // (CL-5) exactly one terminal result event.
  const results = emits.filter(
    (e): e is Extract<ParseEmit, { kind: 'result' }> => e.kind === 'result',
  );
  expect(results).toHaveLength(1);

  const r = results[0].result;
  expect(r.content).toBe('PONG');
  expect(r.isError).toBe(false);
  // (CL-5) usage/cost/duration read off the result event (input 10, output 47).
  expect(r.inputTokens).toBe(10);
  expect(r.outputTokens).toBe(47);
  expect(typeof r.costUsd).toBe('number');
  expect(r.costUsd as number).toBeGreaterThan(0);
  expect(typeof r.durationMs).toBe('number');

  // (CL-5) at least one system/init event is surfaced for diagnostics.
  const inits = emits.filter((e) => e.kind === 'init');
  expect(inits.length).toBeGreaterThanOrEqual(1);
}

describe('StreamParser', () => {
  it('parses the captured fixture fed all at once (CL-5/CL-6)', () => {
    assertFixtureEmits(emitsForChunks([FIXTURE]));
  });

  it('parses the same fixture split into arbitrary mid-line chunks (NF-2)', () => {
    // 7 bytes is intentionally tiny so almost every JSON line is split.
    assertFixtureEmits(emitsForChunks(splitMidline(FIXTURE, 7)));
  });

  it('produces an identical delta/result outcome regardless of chunking', () => {
    const whole = emitsForChunks([FIXTURE]);
    const split = emitsForChunks(splitMidline(FIXTURE, 13));
    const text = (es: ParseEmit[]) =>
      es.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text(split)).toBe(text(whole));
    expect(split.filter((e) => e.kind === 'result')).toHaveLength(1);
  });

  it('ignores malformed JSON without throwing (CL-5)', () => {
    const parser = new StreamParser();
    let emits: ParseEmit[] = [];
    expect(() => {
      emits = parser.feed('{bad json\n');
      emits.push(...parser.end());
    }).not.toThrow();
    expect(emits.some((e) => e.kind === 'ignored')).toBe(true);
  });
});

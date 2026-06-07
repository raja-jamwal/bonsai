// Stream-JSON parser for the `claude` CLI's NDJSON stdout.
//
// Splits on newlines, JSON-parses each line, and dispatches on the `type`
// discriminator; unknown types are ignored for forward-compatibility. Keys only
// on `type` plus a small explicit set of fields; never assumes field ordering
// or presence; never throws on malformed input.
//
// Verified against the captured fixture test/fixtures/stream_capture.ndjson
// produced by CLI v2.1.168.

/** Final, authoritative outcome of one assistant turn (from the result event). */
export interface TurnResult {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  isError: boolean;
  errorText: string | null;
}

/** One thing the parser wants to surface to the caller for a parsed line. */
export type ParseEmit =
  | { kind: 'delta'; text: string }
  | { kind: 'result'; result: TurnResult }
  | { kind: 'init'; raw: unknown }
  | { kind: 'ignored'; raw: string };

// ---------------------------------------------------------------------------
// Narrow, defensive shape helpers. We never assume presence/ordering, so
// everything is read through guards rather than typed casts of the payload.
// ---------------------------------------------------------------------------

/** True for plain (non-null, non-array) objects. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns a finite number or null — tolerates strings/missing/NaN. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Returns a string or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Parse a single already-trimmed-of-newline line into zero or one ParseEmit.
 * Returns `ignored` for blank lines, JSON-parse failures, and any `type` we
 * do not explicitly handle (forward-compatibility). Never throws.
 */
function parseLine(line: string): ParseEmit | null {
  // Tolerate blank lines (e.g. trailing newline produces an empty segment).
  if (line.trim() === '') return null;

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    // Malformed JSON must never throw — surface the raw line instead.
    return { kind: 'ignored', raw: line };
  }

  if (!isRecord(obj)) return { kind: 'ignored', raw: line };

  const type = str(obj['type']);

  switch (type) {
    case 'stream_event':
      return parseStreamEvent(obj, line);

    case 'result':
      return { kind: 'result', result: parseResult(obj) };

    case 'system': {
      // Only the init subtype is interesting for diagnostics.
      if (str(obj['subtype']) === 'init') return { kind: 'init', raw: obj };
      return { kind: 'ignored', raw: line };
    }

    // The cumulative "assistant" snapshot, rate-limit events, and anything else
    // are ignored — we accumulate content ONLY from text_delta to avoid double
    // counting.
    default:
      return { kind: 'ignored', raw: line };
  }
}

/**
 * Handle a `stream_event` wrapper. We only care about
 * content_block_delta -> text_delta (the incremental assistant text). Thinking
 * deltas, signature deltas, message/content_block start/stop, message_delta,
 * etc. are intentionally ignored.
 */
function parseStreamEvent(obj: Record<string, unknown>, line: string): ParseEmit {
  const event = obj['event'];
  if (!isRecord(event)) return { kind: 'ignored', raw: line };

  if (str(event['type']) !== 'content_block_delta') {
    return { kind: 'ignored', raw: line };
  }

  const delta = event['delta'];
  if (!isRecord(delta)) return { kind: 'ignored', raw: line };

  // ONLY text_delta contributes to content (ignore thinking_delta /
  // signature_delta / etc.).
  if (str(delta['type']) !== 'text_delta') {
    return { kind: 'ignored', raw: line };
  }

  const text = str(delta['text']);
  if (text === null) return { kind: 'ignored', raw: line };

  return { kind: 'delta', text };
}

/**
 * Build the authoritative TurnResult from a terminal `result` event.
 * content = result.result (authoritative). On is_error, prefer result.error
 * for errorText, falling back to result.result; content is kept best-effort.
 */
function parseResult(obj: Record<string, unknown>): TurnResult {
  const resultText = str(obj['result']) ?? '';
  const isError = obj['is_error'] === true;

  // Token usage lives under `usage` (may be absent / partial — read defensively).
  const usage = isRecord(obj['usage']) ? obj['usage'] : undefined;

  let errorText: string | null = null;
  if (isError) {
    // Prefer an explicit error field; otherwise fall back to the result text.
    errorText = str(obj['error']) ?? (resultText !== '' ? resultText : null);
  }

  return {
    content: resultText,
    inputTokens: usage ? num(usage['input_tokens']) : null,
    outputTokens: usage ? num(usage['output_tokens']) : null,
    costUsd: num(obj['total_cost_usd']),
    durationMs: num(obj['duration_ms']),
    isError,
    errorText,
  };
}

/**
 * Incremental NDJSON parser. `feed` buffers partial trailing lines across calls
 * (split on newline, keep the remainder); `end` flushes any remaining buffered
 * complete line. Neither ever throws.
 */
export class StreamParser {
  /** Carry-over for a line split across chunk boundaries. */
  private buffer = '';

  /**
   * Feed a chunk of stdout. Returns the emits for every COMPLETE line found;
   * an unterminated trailing fragment is retained for the next call.
   */
  feed(chunk: string): ParseEmit[] {
    this.buffer += chunk;
    const emits: ParseEmit[] = [];

    // Process every complete (newline-terminated) line, keeping the remainder.
    let nlIndex: number;
    while ((nlIndex = this.buffer.indexOf('\n')) !== -1) {
      // Strip a trailing \r so CRLF streams parse cleanly.
      let line = this.buffer.slice(0, nlIndex);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(nlIndex + 1);

      const emit = parseLine(line);
      if (emit !== null) emits.push(emit);
    }

    return emits;
  }

  /** Flush any buffered final line that lacked a trailing newline. */
  end(): ParseEmit[] {
    const remainder = this.buffer;
    this.buffer = '';
    if (remainder === '') return [];

    let line = remainder;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    const emit = parseLine(line);
    return emit !== null ? [emit] : [];
  }
}

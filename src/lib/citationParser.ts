// Streaming citation marker parser. Lifted from src/app/api/ask/route.ts so the
// route stays focused on transport (CORS, SSE, abort plumbing) and the parsing
// algorithm can be tested without importing an /api/ path.
//
// The model emits inline markers like `[chunk:42]`. As Anthropic streams text
// deltas, those markers can land anywhere — including split across two deltas
// (e.g. `…fact[chu` then `nk:42] more…`). parseDelta uses a rolling buffer
// with MARKER_LOOKAHEAD so a trailing `[` is held until either it completes
// into a marker, or it's clearly literal `[` text.

import type { Citation, RetrievedChunk } from './types';

export const QUOTE_MAX_CHARS = 160;
// Long enough to hold "[chunk:NNNN]" while we wait to see if a trailing "[" is
// the start of a citation marker.
export const MARKER_LOOKAHEAD = 16;

export type ParserState = { buffer: string };

export function buildCitation(chunk: RetrievedChunk): Citation {
  const quote =
    chunk.content.length <= QUOTE_MAX_CHARS
      ? chunk.content
      : chunk.content.slice(0, QUOTE_MAX_CHARS).trimEnd() + '…';
  return {
    chunkId: chunk.id,
    sourcePath: chunk.sourcePath,
    section: chunk.section,
    quote,
  };
}

export function parseDelta(delta: string, state: ParserState): { text: string; cited: number[] } {
  state.buffer += delta;

  const markerRegex = /\[chunk:(\d+)\]/g;
  const cited: number[] = [];
  let textOut = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markerRegex.exec(state.buffer)) !== null) {
    textOut += state.buffer.slice(lastIndex, match.index);
    cited.push(parseInt(match[1], 10));
    lastIndex = match.index + match[0].length;
  }

  const tail = state.buffer.slice(lastIndex);
  const lastOpen = tail.lastIndexOf('[');
  if (lastOpen >= 0 && tail.length - lastOpen < MARKER_LOOKAHEAD) {
    textOut += tail.slice(0, lastOpen);
    state.buffer = tail.slice(lastOpen);
  } else {
    textOut += tail;
    state.buffer = '';
  }

  return { text: textOut, cited };
}

export function flushBuffer(state: ParserState): string {
  const remainder = state.buffer;
  state.buffer = '';
  return remainder;
}

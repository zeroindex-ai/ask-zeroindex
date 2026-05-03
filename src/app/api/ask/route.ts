import { NextRequest } from 'next/server';
import { z } from 'zod';
import { hybridSearch } from '@/lib/retrieval';
import { answer, ANSWER_MODEL } from '@/lib/claude';
import { encodeSSE } from '@/lib/sse';
import { errMsg } from '@/lib/errors';
import type { Citation, RetrievedChunk } from '@/lib/types';

type AskTrace = {
  question: string;
  outcome: 'ok' | 'retrieval_failed' | 'stream_failed' | 'aborted';
  retrievedIds: number[];
  citationCount: number;
  retrievalMs: number;
  firstTokenMs: number | null;
  totalMs: number;
  errorMessage?: string;
};

// Single-line JSON for Vercel log aggregation. Search/filter via the Vercel
// dashboard or `vercel logs --json` and grep on event=ask.
function logAsk(trace: AskTrace): void {
  console.log(
    JSON.stringify({ event: 'ask', ts: new Date().toISOString(), model: ANSWER_MODEL, ...trace })
  );
}

export const runtime = 'nodejs';

export const Body = z.object({
  question: z.string().min(1).max(500),
});

const QUOTE_MAX_CHARS = 160;
// Long enough to hold "[chunk:NNNN]" while we wait to see if a trailing "[" is
// the start of a citation marker.
const MARKER_LOOKAHEAD = 16;

// Comma-separated list of allowed origins. Empty = allow all (dev default).
// Origin "null" matches file:// and the preview HTML.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function originAllowed(origin: string | null): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin ?? 'null');
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (ALLOWED_ORIGINS.length === 0) return { 'Access-Control-Allow-Origin': '*' };
  return {
    'Access-Control-Allow-Origin': origin ?? 'null',
    Vary: 'Origin',
  };
}

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

export type ParserState = { buffer: string };

export function parseDelta(
  delta: string,
  state: ParserState
): { text: string; cited: number[] } {
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

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!originAllowed(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (!originAllowed(origin)) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const cors = corsHeaders(origin);

  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400, headers: cors });
  }
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400, headers: cors }
    );
  }

  const question = parsed.data.question;
  const t0 = Date.now();

  // Retrieval boundary — failures here return a normal HTTP error rather than
  // opening an SSE stream just to send a single error event.
  let chunks: RetrievedChunk[];
  try {
    chunks = await hybridSearch(question);
  } catch (err) {
    console.error('retrieval failed:', errMsg(err));
    logAsk({
      question,
      outcome: 'retrieval_failed',
      retrievedIds: [],
      citationCount: 0,
      retrievalMs: Date.now() - t0,
      firstTokenMs: null,
      totalMs: Date.now() - t0,
      errorMessage: errMsg(err),
    });
    return Response.json(
      { error: 'retrieval_failed', message: 'Could not retrieve sources. Please try again.' },
      { status: 502, headers: cors }
    );
  }

  const tRetrieval = Date.now();
  const chunkById = new Map(chunks.map((c) => [c.id, c]));

  const body = new ReadableStream({
    async start(controller) {
      const state: ParserState = { buffer: '' };
      const seen = new Set<number>();
      const citations: Citation[] = [];
      let closed = false;
      let firstTokenAt: number | null = null;
      let outcome: AskTrace['outcome'] = 'ok';
      let errorMessage: string | undefined;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      try {
        safeEnqueue(encodeSSE({ type: 'chunks', data: chunks.map((c) => c.id) }));

        // Pass req.signal so a client disconnect cancels the upstream Anthropic
        // request — otherwise we'd keep paying for tokens nobody is reading.
        const stream = await answer(question, chunks, req.signal);

        for await (const event of stream) {
          if (req.signal.aborted) break;
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            const { text, cited } = parseDelta(event.delta.text, state);
            if (text) safeEnqueue(encodeSSE({ type: 'text', data: text }));
            for (const id of cited) {
              if (seen.has(id)) continue;
              seen.add(id);
              const ch = chunkById.get(id);
              if (!ch) continue; // model fabricated an id; skip
              const cit = buildCitation(ch);
              citations.push(cit);
              safeEnqueue(encodeSSE({ type: 'citation', data: cit }));
            }
          }
        }

        if (!req.signal.aborted) {
          const tail = flushBuffer(state);
          if (tail) safeEnqueue(encodeSSE({ type: 'text', data: tail }));
          safeEnqueue(encodeSSE({ type: 'done', data: { citations } }));
        } else {
          outcome = 'aborted';
        }
      } catch (err) {
        if (req.signal.aborted) {
          outcome = 'aborted';
        } else {
          outcome = 'stream_failed';
          errorMessage = errMsg(err);
          console.error('stream failed:', errorMessage);
          // Generic message — raw upstream errors can leak quota / header info.
          safeEnqueue(
            encodeSSE({ type: 'error', data: { message: 'Could not generate answer. Please try again.' } })
          );
        }
      } finally {
        closed = true;
        logAsk({
          question,
          outcome,
          retrievedIds: chunks.map((c) => c.id),
          citationCount: citations.length,
          retrievalMs: tRetrieval - t0,
          firstTokenMs: firstTokenAt === null ? null : firstTokenAt - t0,
          totalMs: Date.now() - t0,
          ...(errorMessage ? { errorMessage } : {}),
        });
        try {
          controller.close();
        } catch {
          // already closed (e.g. client disconnect)
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { hybridSearch } from '@/lib/retrieval';
import { answer, ANSWER_MODEL } from '@/lib/claude';
import { encodeSSE } from '@/lib/sse';
import { errMsg } from '@/lib/errors';
import { logAsk, type AskTrace } from '@/lib/logAsk';
import { bucketKeyFromHeaders, checkRateLimit } from '@/lib/rateLimit';
import { buildCitation, flushBuffer, parseDelta, type ParserState } from '@/lib/citationParser';
import type { Citation, RetrievedChunk } from '@/lib/types';

export const runtime = 'nodejs';

export const Body = z.object({
  question: z.string().min(1).max(500),
});

// Well above the 500-char question limit + small JSON envelope. Rejects JSON
// bombs before they reach req.json().
const MAX_BODY_BYTES = 4096;

// Comma-separated list of allowed origins. Empty = allow all (dev default).
// Origin "null" matches file:// and the preview HTML.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Loud one-time signal: an empty ALLOWED_ORIGINS in production silently falls
// back to `Access-Control-Allow-Origin: *`. We deliberately keep the open
// behavior here (the live embedded widget may rely on it and prod config can't
// be verified from this repo), but a forgotten env var should not be silent.
// The stronger option a deployer can opt into is fail-closed: reject requests
// with no configured origins instead of allowing all. Module-level guard so the
// warning fires at most once, not per request.
const IS_PRODUCTION =
  process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
if (ALLOWED_ORIGINS.length === 0 && IS_PRODUCTION) {
  console.error(
    '[ask/route] ALLOWED_ORIGINS is unset in production — CORS is wide open ' +
      '(Access-Control-Allow-Origin: *). Set ALLOWED_ORIGINS to lock down the API.'
  );
}

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

  // Defense in depth: refuse oversize bodies before req.json() parses them.
  // Zod's max(500) on `question` is a content-level check; this is a byte
  // ceiling for the envelope.
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return Response.json({ error: 'payload_too_large' }, { status: 413, headers: cors });
    }
  }

  // Rate limit before doing any paid-API work. Failure to read state should
  // not hard-fail legitimate traffic — log and pass through.
  try {
    const key = bucketKeyFromHeaders(req.headers);
    const decision = await checkRateLimit(key);
    if (!decision.allowed) {
      return Response.json(
        { error: 'rate_limited', message: 'Too many requests. Please slow down.' },
        {
          status: 429,
          headers: { ...cors, 'Retry-After': String(decision.retryAfterSec) },
        }
      );
    }
  } catch (err) {
    console.warn('rate-limit check failed; allowing request:', errMsg(err));
  }

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
    logAsk(
      {
        question,
        outcome: 'retrieval_failed',
        retrievedIds: [],
        citationCount: 0,
        retrievalMs: Date.now() - t0,
        firstTokenMs: null,
        totalMs: Date.now() - t0,
        errorMessage: errMsg(err),
      },
      { model: ANSWER_MODEL }
    );
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
        logAsk(
          {
            question,
            outcome,
            retrievedIds: chunks.map((c) => c.id),
            citationCount: citations.length,
            retrievalMs: tRetrieval - t0,
            firstTokenMs: firstTokenAt === null ? null : firstTokenAt - t0,
            totalMs: Date.now() - t0,
            ...(errorMessage ? { errorMessage } : {}),
          },
          { model: ANSWER_MODEL }
        );
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RetrievedChunk } from '@/lib/types';
import type { AskEvent } from '@/lib/sse';

// End-to-end exercise of the /api/ask SSE stream with the two paid boundaries
// (retrieval + Anthropic) mocked. Asserts the event protocol ordering
// (chunks → text → citation → done) and that inline [chunk:N] citation markers
// are stripped from the streamed text. Deterministic: no real network, no timers.

const CHUNKS: RetrievedChunk[] = [
  {
    id: 3,
    sourcePath: '/services',
    section: 'Integration Audit',
    content: 'A 2–3 week, fixed-fee assessment of where Claude fits your stack.',
    score: 0.9,
    source: 'rerank',
  },
  {
    id: 21,
    sourcePath: '/pricing',
    section: 'Pricing',
    content: 'Pricing is fixed-fee per engagement, defined in the SOW before work starts.',
    score: 0.8,
    source: 'rerank',
  },
];

// Minimal shape of the Anthropic content_block_delta events the route reads.
function textDelta(text: string) {
  return { type: 'content_block_delta' as const, delta: { type: 'text_delta' as const, text } };
}

// The model emits citation markers inline; deltas can split a marker across
// boundaries. This script exercises both: a clean marker (`[chunk:3]`) and one
// that arrives split across two deltas (`[chu` + `nk:21]`).
function fakeAnthropicStream(): AsyncGenerator<ReturnType<typeof textDelta>> {
  const deltas = [
    textDelta('The integration audit is a fixed-fee assessment'),
    textDelta('[chunk:3]'),
    textDelta('. Pricing is fixed-fee per engagement[chu'),
    textDelta('nk:21]. That is the whole story.'),
  ];
  return (async function* () {
    for (const d of deltas) yield d;
  })();
}

const hybridSearch = vi.fn(async () => CHUNKS);
const answer = vi.fn(async () => fakeAnthropicStream());

vi.mock('@/lib/retrieval', () => ({ hybridSearch: () => hybridSearch() }));
vi.mock('@/lib/claude', () => ({
  answer: () => answer(),
  ANSWER_MODEL: 'claude-sonnet-4-6',
}));
vi.mock('@/lib/rateLimit', () => ({
  bucketKeyFromHeaders: vi.fn(() => 'ip:test'),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9 })),
}));
vi.mock('@/lib/logAsk', () => ({ logAsk: vi.fn() }));

import { POST } from './route';
import { parseSSE } from '@/lib/sse';
import type { NextRequest } from 'next/server';

function fakeRequest(body: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

async function drain(res: Response): Promise<AskEvent[]> {
  const events: AskEvent[] = [];
  for await (const evt of parseSSE(res)) events.push(evt);
  return events;
}

describe('POST /api/ask SSE stream (integration)', () => {
  beforeEach(() => {
    hybridSearch.mockClear();
    answer.mockClear();
  });

  it('emits chunks → text → citation → done in order and strips citation markers', async () => {
    const res = await POST(fakeRequest({ question: 'What is the integration audit?' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const events = await drain(res);
    const types = events.map((e) => e.type);

    // First event is always the retrieved chunk-id manifest.
    expect(types[0]).toBe('chunks');
    // Last event is the terminal done frame.
    expect(types[types.length - 1]).toBe('done');
    // No error frame on the happy path.
    expect(types).not.toContain('error');

    // Ordering invariant: every citation arrives after the first text frame and
    // before done; chunks precedes all text. Assert relative ordering of the
    // canonical sequence chunks → text → citation → done.
    const firstText = types.indexOf('text');
    const firstCitation = types.indexOf('citation');
    const doneIdx = types.indexOf('done');
    expect(types.indexOf('chunks')).toBe(0);
    expect(firstText).toBeGreaterThan(0);
    expect(firstCitation).toBeGreaterThan(firstText);
    expect(doneIdx).toBeGreaterThan(firstCitation);

    // The streamed text must have NO citation markers left in it.
    const fullText = events
      .filter((e): e is Extract<AskEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.data)
      .join('');
    expect(fullText).not.toMatch(/\[chunk:\d+\]/);
    // Including the marker that was split across two deltas.
    expect(fullText).not.toContain('[chu');
    expect(fullText).toContain('The integration audit is a fixed-fee assessment');
    expect(fullText).toContain('. That is the whole story.');

    // Both cited chunks surface as citation events, in first-seen order.
    const citations = events.filter(
      (e): e is Extract<AskEvent, { type: 'citation' }> => e.type === 'citation'
    );
    expect(citations.map((c) => c.data.chunkId)).toEqual([3, 21]);

    // done carries the full citation list.
    const done = events.find(
      (e): e is Extract<AskEvent, { type: 'done' }> => e.type === 'done'
    );
    expect(done?.data.citations.map((c) => c.chunkId)).toEqual([3, 21]);

    // Boundaries were actually driven.
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledOnce();
  });
});

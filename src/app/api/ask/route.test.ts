import { describe, it, expect, vi } from 'vitest';

// Stub heavy/external dependencies — the only POST path exercised here is the
// pre-validation Content-Length ceiling, but importing ./route pulls in all
// transitive modules.
vi.mock('@/lib/retrieval', () => ({ hybridSearch: vi.fn() }));
vi.mock('@/lib/claude', () => ({
  answer: vi.fn(),
  ANSWER_MODEL: 'claude-sonnet-4-6',
}));
vi.mock('@/lib/rateLimit', () => ({
  bucketKeyFromHeaders: vi.fn(() => 'ip:test'),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9 })),
}));
vi.mock('@/lib/logAsk', () => ({ logAsk: vi.fn() }));

import { Body, POST } from './route';
import type { NextRequest } from 'next/server';

describe('POST Content-Length ceiling', () => {
  function fakeRequest(headers: Record<string, string>): NextRequest {
    return {
      headers: new Headers(headers),
      json: async () => ({}),
      signal: new AbortController().signal,
    } as unknown as NextRequest;
  }

  it('returns 413 when Content-Length exceeds 4096', async () => {
    const res = await POST(fakeRequest({ 'content-length': String(8192) }));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe('payload_too_large');
  });

  it('allows requests with no Content-Length header (falls through to validation)', async () => {
    const res = await POST(fakeRequest({}));
    // Body parse yields {}; Zod rejects → 400 invalid_body. Not a 413.
    expect(res.status).not.toBe(413);
  });

  it('allows requests at the 4096-byte boundary', async () => {
    const res = await POST(fakeRequest({ 'content-length': '4096' }));
    expect(res.status).not.toBe(413);
  });
});

describe('Body validator', () => {
  it('accepts a normal question', () => {
    expect(Body.safeParse({ question: 'What does ZeroIndex do?' }).success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(Body.safeParse({ question: '' }).success).toBe(false);
  });

  it('rejects missing field', () => {
    expect(Body.safeParse({}).success).toBe(false);
  });

  it('rejects non-string', () => {
    expect(Body.safeParse({ question: 42 }).success).toBe(false);
  });

  it('rejects > 500 chars', () => {
    expect(Body.safeParse({ question: 'a'.repeat(501) }).success).toBe(false);
  });

  it('accepts exactly 500 chars', () => {
    expect(Body.safeParse({ question: 'a'.repeat(500) }).success).toBe(true);
  });

  it('rejects null body', () => {
    expect(Body.safeParse(null).success).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_VOYAGE_KEY = process.env.VOYAGE_API_KEY;

describe('Voyage retry policy (via embedDocuments)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Make sleep() instant so retries don't add real seconds to test time.
    vi.useFakeTimers();
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fetchSpy?.mockRestore();
    vi.useRealTimers();
    if (ORIGINAL_VOYAGE_KEY === undefined) {
      delete process.env.VOYAGE_API_KEY;
    } else {
      process.env.VOYAGE_API_KEY = ORIGINAL_VOYAGE_KEY;
    }
  });

  function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function embedOk(): Response {
    return makeJsonResponse({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
      model: 'voyage-3',
      usage: { total_tokens: 1 },
    });
  }

  it('retries on 5xx and returns the 200 result', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(embedOk());

    const { embedDocuments } = await import('./embeddings');
    const promise = embedDocuments(['hello']);
    // Drain the 1s backoff sleep.
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after 3 consecutive 5xx responses', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('still broken', { status: 502 }));

    const { embedDocuments } = await import('./embeddings');
    const promise = embedDocuments(['hello']).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Voyage .* 502/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 4xx — throws immediately', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('bad request', { status: 400 }));

    const { embedDocuments } = await import('./embeddings');
    const promise = embedDocuments(['hello']).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Voyage .* 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on TypeError (network failure) and returns the 200 result', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(embedOk());

    const { embedDocuments } = await import('./embeddings');
    const promise = embedDocuments(['hello']);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logAsk, type AskTrace } from './logAsk';

const SAMPLE_TRACE: AskTrace = {
  question: 'what services do you offer?',
  outcome: 'ok',
  retrievedIds: [42, 17, 9],
  citationCount: 2,
  retrievalMs: 412,
  firstTokenMs: 1180,
  totalMs: 4730,
};

const MODEL = 'claude-sonnet-4-6';

describe('logAsk', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;
  const savedEnv = {
    TRACE_PACK_URL: process.env.TRACE_PACK_URL,
    TRACE_PACK_TOKEN: process.env.TRACE_PACK_TOKEN,
    TRACE_PACK_SOURCE: process.env.TRACE_PACK_SOURCE,
  };

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    delete process.env.TRACE_PACK_URL;
    delete process.env.TRACE_PACK_TOKEN;
    delete process.env.TRACE_PACK_SOURCE;
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    global.fetch = originalFetch;
    process.env.TRACE_PACK_URL = savedEnv.TRACE_PACK_URL;
    process.env.TRACE_PACK_TOKEN = savedEnv.TRACE_PACK_TOKEN;
    process.env.TRACE_PACK_SOURCE = savedEnv.TRACE_PACK_SOURCE;
  });

  function flushMicrotasks() {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  it('writes one single-line JSON record to console.log with source/event/ts/model', () => {
    logAsk(SAMPLE_TRACE, { model: MODEL });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(typeof line).toBe('string');
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed.source).toBe('ask-zeroindex');
    expect(parsed.event).toBe('ask');
    expect(parsed.model).toBe(MODEL);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.question).toBe(SAMPLE_TRACE.question);
    expect(parsed.outcome).toBe('ok');
    expect(parsed.totalMs).toBe(4730);
  });

  it('does NOT call fetch when TRACE_PACK_URL is unset', () => {
    process.env.TRACE_PACK_TOKEN = 'token';
    logAsk(SAMPLE_TRACE, { model: MODEL });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when TRACE_PACK_TOKEN is unset', () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    logAsk(SAMPLE_TRACE, { model: MODEL });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to {TRACE_PACK_URL}/api/ingest with bearer auth + keepalive when both env vars set', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'my-secret-token';

    logAsk(SAMPLE_TRACE, { model: MODEL });
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://traces.zeroindex.ai/api/ingest');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-secret-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(body.source).toBe('ask-zeroindex');
    expect(body.event).toBe('ask');
    expect(body.question).toBe(SAMPLE_TRACE.question);
    expect(body.outcome).toBe('ok');
  });

  it('strips a trailing slash from TRACE_PACK_URL before appending /api/ingest', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai/';
    process.env.TRACE_PACK_TOKEN = 'token';
    logAsk(SAMPLE_TRACE, { model: MODEL });
    await flushMicrotasks();
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('https://traces.zeroindex.ai/api/ingest');
  });

  it('swallows fetch errors and warns', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'token';
    fetchSpy.mockRejectedValue(new Error('network down'));

    expect(() => logAsk(SAMPLE_TRACE, { model: MODEL })).not.toThrow();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('trace-pack ingest failed');
  });

  it('honors TRACE_PACK_SOURCE override', () => {
    process.env.TRACE_PACK_SOURCE = 'custom-source';
    logAsk(SAMPLE_TRACE, { model: MODEL });
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.source).toBe('custom-source');
  });

  it('preserves errorMessage when outcome is a failure', () => {
    const failTrace: AskTrace = { ...SAMPLE_TRACE, outcome: 'stream_failed', errorMessage: 'rate limit hit' };
    logAsk(failTrace, { model: MODEL });
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed.outcome).toBe('stream_failed');
    expect(parsed.errorMessage).toBe('rate limit hit');
  });
});

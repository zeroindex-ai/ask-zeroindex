export type AskTrace = {
  question: string;
  outcome: 'ok' | 'retrieval_failed' | 'stream_failed' | 'aborted';
  retrievedIds: number[];
  citationCount: number;
  retrievalMs: number;
  firstTokenMs: number | null;
  totalMs: number;
  errorMessage?: string;
  // Anthropic token usage, when a model call happened. Powers trace-pack's cost
  // view. Null/absent on the retrieval-failure path (no model call) or when the
  // stream aborts before usage is reported.
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
};

type LoggedPayload = AskTrace & {
  source: string;
  event: 'ask';
  ts: string;
  model: string;
};

const DEFAULT_SOURCE = 'ask-zeroindex';

export function logAsk(trace: AskTrace, opts: { model: string }): void {
  const payload: LoggedPayload = {
    source: process.env.TRACE_PACK_SOURCE ?? DEFAULT_SOURCE,
    event: 'ask',
    ts: new Date().toISOString(),
    model: opts.model,
    ...trace,
  };
  const serialized = JSON.stringify(payload);

  // Vercel aggregates this stdout line; filter on event=ask via `vercel logs --json`.
  console.log(serialized);

  // Optional dual-write to trace-pack. Fire-and-forget: never blocks the response.
  const url = process.env.TRACE_PACK_URL;
  const token = process.env.TRACE_PACK_TOKEN;
  if (url && token) {
    void sendToTracePack(`${url.replace(/\/$/, '')}/api/ingest`, token, serialized);
  }
}

async function sendToTracePack(url: string, token: string, body: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
      // keepalive lets the request finish after the route response is sent,
      // so the Vercel function isn't terminated mid-POST.
      keepalive: true,
    });
  } catch (err) {
    console.warn('trace-pack ingest failed:', err instanceof Error ? err.message : String(err));
  }
}

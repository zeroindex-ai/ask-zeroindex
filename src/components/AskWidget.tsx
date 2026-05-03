'use client';

import { useEffect, useRef, useState } from 'react';
import { parseSSE } from '@/lib/sse';
import { errMsg } from '@/lib/errors';
import type { Citation } from '@/lib/types';

type Status = 'idle' | 'retrieving' | 'streaming' | 'done' | 'error';

const SUGGESTED = [
  'What services does ZeroIndex offer?',
  'How does pricing work?',
  'Tell me about Abhishek.',
  'How does an engagement start?',
];

const PILL_CLASS =
  'rounded-full border border-[var(--line)] bg-transparent px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent-1)] hover:text-white';

const initialState = {
  question: '',
  status: 'idle' as Status,
  answer: '',
  citations: [] as Citation[],
  retrievedCount: 0,
  error: null as string | null,
  expanded: new Set<number>(),
};

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export type AskWidgetProps = {
  endpoint?: string;
  showFooterCredits?: boolean;
};

export function AskWidget({ endpoint = '/api/ask', showFooterCredits = true }: AskWidgetProps) {
  const [question, setQuestion] = useState(initialState.question);
  const [status, setStatus] = useState<Status>(initialState.status);
  const [answer, setAnswer] = useState(initialState.answer);
  const [citations, setCitations] = useState<Citation[]>(initialState.citations);
  const [retrievedCount, setRetrievedCount] = useState(initialState.retrievedCount);
  const [error, setError] = useState<string | null>(initialState.error);
  const [expanded, setExpanded] = useState<Set<number>>(initialState.expanded);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // preventScroll stops the parent (when iframed) from auto-scrolling the
    // iframe into view on mount — that scroll-jump is jarring to embed visitors.
    inputRef.current?.focus({ preventScroll: true });
    return () => abortRef.current?.abort();
  }, []);

  function resetState() {
    setQuestion(initialState.question);
    setStatus(initialState.status);
    setAnswer(initialState.answer);
    setCitations(initialState.citations);
    setRetrievedCount(initialState.retrievedCount);
    setError(initialState.error);
    setExpanded(new Set());
  }

  async function ask(q: string) {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;

    resetState();
    setQuestion(q);
    setStatus('retrieving');

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (isAbortError(e)) return;
      setError(errMsg(e));
      setStatus('error');
      return;
    }

    if (!res.ok) {
      const j: { message?: string; error?: string } = await res.json().catch(() => ({}));
      setError(j.message ?? j.error ?? `request failed (${res.status})`);
      setStatus('error');
      return;
    }

    try {
      for await (const evt of parseSSE(res)) {
        switch (evt.type) {
          case 'chunks':
            setRetrievedCount(evt.data.length);
            setStatus('streaming');
            break;
          case 'text':
            setAnswer((prev) => prev + evt.data);
            break;
          case 'citation':
            setCitations((prev) => [...prev, evt.data]);
            break;
          case 'done':
            setStatus('done');
            break;
          case 'error':
            setError(evt.data.message);
            setStatus('error');
            break;
        }
      }
    } catch (e) {
      if (isAbortError(e)) return;
      setError(errMsg(e));
      setStatus('error');
    }
  }

  function submit() {
    const q = question.trim();
    if (!q || status === 'retrieving' || status === 'streaming') return;
    ask(q);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Skip Enter while an IME composition is active (CJK/etc input methods).
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    abortRef.current?.abort();
    resetState();
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }

  const busy = status === 'retrieving' || status === 'streaming';
  const showEmpty = status === 'idle' && !answer;

  return (
    <>
      <form onSubmit={onSubmit} className="mb-6">
        <div className="flex items-stretch gap-2">
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything about ZeroIndex…"
            aria-label="Ask a question about ZeroIndex"
            rows={2}
            disabled={busy}
            className="flex-1 resize-none rounded-md border border-[var(--line)] bg-transparent px-3 py-2 text-sm leading-relaxed text-white placeholder:text-[var(--muted-2)] focus:border-[var(--accent-1)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-1)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !question.trim()}
            aria-label={busy ? 'Sending' : 'Send question'}
            className="inline-flex w-20 items-center justify-center rounded-md bg-white px-5 text-sm font-semibold text-black transition-all hover:bg-neutral-200 hover:shadow-[0_8px_24px_-12px_rgba(124,58,237,0.35)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-1)] focus:ring-offset-2 focus:ring-offset-black disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none"
          >
            {busy ? '…' : 'Ask'}
          </button>
        </div>
      </form>

      {showEmpty && (
        <div className="space-y-3">
          <p className="label">Try asking</p>
          <ul className="flex flex-wrap gap-2">
            {SUGGESTED.map((s) => (
              <li key={s}>
                <button type="button" onClick={() => ask(s)} className={PILL_CLASS}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(status !== 'idle' || answer) && (
        <div className="space-y-4">
          {status === 'retrieving' && (
            <p className="text-sm text-[var(--muted)]" aria-live="polite">
              Retrieving sources
              <Dots />
            </p>
          )}
          {status === 'streaming' && retrievedCount > 0 && !answer && (
            <p className="text-sm text-[var(--muted)]" aria-live="polite">
              Found {retrievedCount} sources. Generating answer
              <Dots />
            </p>
          )}

          {answer && (
            <div
              aria-live="polite"
              className="rounded-md border border-[var(--line)] px-4 py-3 text-[15px] leading-[1.7] text-white whitespace-pre-wrap"
            >
              {answer}
              {status === 'streaming' && (
                <span aria-hidden="true" className="text-[var(--accent-1)]">▍</span>
              )}
            </div>
          )}

          {citations.length > 0 && (
            <div className="space-y-2">
              <p className="label" id="sources-heading">
                Sources ({citations.length})
              </p>
              <ul className="space-y-1.5" aria-labelledby="sources-heading">
                {citations.map((c, i) => {
                  const isOpen = expanded.has(c.chunkId);
                  const panelId = `citation-${c.chunkId}`;
                  return (
                    <li key={c.chunkId}>
                      <button
                        type="button"
                        onClick={() => toggleExpand(c.chunkId)}
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        className="group flex w-full items-start gap-2 rounded border border-[var(--line)] bg-transparent px-3 py-2 text-left text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent-1)]"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-1)] text-[10px] font-semibold text-white"
                        >
                          {i + 1}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate font-medium text-white">
                            {c.section ?? '(unsectioned)'}
                          </span>
                          {isOpen && (
                            <span id={panelId} className="mt-1 block text-[var(--muted)]">
                              {c.quote}
                            </span>
                          )}
                        </span>
                        <span
                          aria-hidden="true"
                          className="mt-0.5 text-base font-bold leading-none text-[var(--muted)] group-hover:text-white"
                        >
                          {isOpen ? '−' : '+'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
            >
              <strong className="font-semibold">Error: </strong>
              {error}
            </div>
          )}

          {(status === 'done' || status === 'error') && (
            <div className="flex justify-end pt-1">
              <button type="button" onClick={reset} className={PILL_CLASS}>
                Clear and ask another
              </button>
            </div>
          )}
        </div>
      )}

      {showFooterCredits && (
        <p className="mt-10 text-sm text-[var(--muted)]">
          Powered by Claude Sonnet 4.6 · Voyage-3 + rerank-2.5 · Turso libsql · Next.js 16
        </p>
      )}
    </>
  );
}

function Dots() {
  return (
    <span aria-hidden="true" className="ml-0.5 inline-flex gap-0.5">
      <span className="animate-pulse">.</span>
      <span className="animate-pulse [animation-delay:0.15s]">.</span>
      <span className="animate-pulse [animation-delay:0.3s]">.</span>
    </span>
  );
}

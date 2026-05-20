// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AskWidget } from './AskWidget';

const SUGGESTED = [
  'What services does ZeroIndex offer?',
  'How does pricing work?',
  'Tell me about Abhishek.',
  'How does an engagement start?',
];

// Build an SSE Response from a list of {type,data} events, matching encodeSSE's
// wire format (`event: <type>\ndata: <json>\n\n`). parseSSE reads this back.
function sseResponse(events: Array<{ type: string; data: unknown }>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AskWidget — empty state', () => {
  it('renders the textarea, disabled send button, and all 4 suggestions', () => {
    render(<AskWidget />);

    expect(screen.getByRole('textbox', { name: /ask a question about zeroindex/i })).toBeDefined();

    const send = screen.getByRole('button', { name: /send question/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    for (const s of SUGGESTED) {
      expect(screen.getByRole('button', { name: s })).toBeDefined();
    }
  });
});

describe('AskWidget — suggestion click triggers fetch', () => {
  beforeEach(() => {
    // fetch returns a pending promise so the widget stays in `retrieving` state.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
  });

  it('POSTs the suggestion text to /api/ask and surfaces the retrieving state', async () => {
    render(<AskWidget />);

    fireEvent.click(screen.getByRole('button', { name: SUGGESTED[0] }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/ask');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ question: SUGGESTED[0] });

    expect(screen.getByText(/retrieving sources/i)).toBeDefined();
  });
});

describe('AskWidget — error response surfaces error UI and reset button', () => {
  it('shows the error message and a Clear-and-ask-another control on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'retrieval failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    render(<AskWidget />);
    fireEvent.click(screen.getByRole('button', { name: SUGGESTED[1] }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/retrieval failed/i);
    });
    expect(screen.getByRole('button', { name: /clear and ask another/i })).toBeDefined();
  });
});

describe('AskWidget — typing enables send and Enter submits', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
  });

  it('enables the send button once the textarea has non-empty text', () => {
    render(<AskWidget />);
    const send = screen.getByRole('button', { name: /send question/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    const textarea = screen.getByRole('textbox', { name: /ask a question about zeroindex/i });
    fireEvent.change(textarea, { target: { value: 'hello there' } });
    expect(send.disabled).toBe(false);
  });

  it('submits the typed question on Enter (without Shift)', async () => {
    render(<AskWidget />);
    const textarea = screen.getByRole('textbox', { name: /ask a question about zeroindex/i });
    fireEvent.change(textarea, { target: { value: 'what is the SLA?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({ question: 'what is the SLA?' });
  });

  it('does not submit on Shift+Enter', () => {
    render(<AskWidget />);
    const textarea = screen.getByRole('textbox', { name: /ask a question about zeroindex/i });
    fireEvent.change(textarea, { target: { value: 'multi\nline' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('AskWidget — streaming flow renders answer, citations, and done state', () => {
  it('streams text + a citation, then shows the reset control on done', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'chunks', data: [101, 102] },
        { type: 'text', data: 'ZeroIndex offers ' },
        { type: 'text', data: 'RAG widgets.' },
        {
          type: 'citation',
          data: { chunkId: 101, section: 'Services', quote: 'We build RAG widgets.' },
        },
        { type: 'done', data: { citations: [] } },
      ])
    );

    render(<AskWidget />);
    fireEvent.click(screen.getByRole('button', { name: SUGGESTED[0] }));

    await waitFor(() => {
      expect(screen.getByText(/ZeroIndex offers RAG widgets\./)).toBeDefined();
    });

    // Citation appears with its section label.
    expect(screen.getByText('Services')).toBeDefined();
    expect(screen.getByText(/Sources \(1\)/)).toBeDefined();

    // Done state surfaces the reset control.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /clear and ask another/i })).toBeDefined();
    });
  });

  it('expands and collapses a citation quote on click', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'chunks', data: [201] },
        { type: 'text', data: 'See source.' },
        {
          type: 'citation',
          data: { chunkId: 201, section: 'Pricing', quote: 'Pricing is per engagement.' },
        },
        { type: 'done', data: { citations: [] } },
      ])
    );

    render(<AskWidget />);
    fireEvent.click(screen.getByRole('button', { name: SUGGESTED[1] }));

    const citationToggle = await screen.findByRole('button', { name: /Pricing/ });
    expect(citationToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Pricing is per engagement.')).toBeNull();

    fireEvent.click(citationToggle);
    expect(citationToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Pricing is per engagement.')).toBeDefined();

    fireEvent.click(citationToggle);
    expect(citationToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Pricing is per engagement.')).toBeNull();
  });

  it('clears back to the empty state when Clear-and-ask-another is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'chunks', data: [301] },
        { type: 'text', data: 'An answer.' },
        { type: 'done', data: { citations: [] } },
      ])
    );

    render(<AskWidget />);
    fireEvent.click(screen.getByRole('button', { name: SUGGESTED[2] }));

    const resetBtn = await screen.findByRole('button', { name: /clear and ask another/i });
    fireEvent.click(resetBtn);

    // Back to empty state: suggestions are shown again and the answer is gone.
    await waitFor(() => {
      expect(screen.queryByText('An answer.')).toBeNull();
    });
    expect(screen.getByText(/Try asking/i)).toBeDefined();
  });
});

describe('AskWidget — error event during stream surfaces error UI', () => {
  it('renders the error alert when the stream emits an error event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'chunks', data: [401] },
        { type: 'error', data: { message: 'Could not generate answer. Please try again.' } },
      ])
    );

    render(<AskWidget />);
    fireEvent.click(screen.getByRole('button', { name: SUGGESTED[3] }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not generate answer/i);
    });
  });
});

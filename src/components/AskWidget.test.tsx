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

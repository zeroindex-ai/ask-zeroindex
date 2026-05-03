// SSE wire format shared between the route handler and the browser widget.
// Single source of truth for the event protocol — server encodes via encodeSSE,
// client iterates via parseSSE; types stay aligned at compile time.

import type { Citation } from './types';

export type AskEvent =
  | { type: 'chunks'; data: number[] }
  | { type: 'text'; data: string }
  | { type: 'citation'; data: Citation }
  | { type: 'done'; data: { citations: Citation[] } }
  | { type: 'error'; data: { message: string } };

const encoder = new TextEncoder();

export function encodeSSE(event: AskEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export async function* parseSSE(response: Response): AsyncGenerator<AskEvent> {
  if (!response.body) throw new Error('SSE response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const trimmed = frame.trim();
      if (!trimmed) continue;
      let evtName = 'message';
      const dataLines: string[] = [];
      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event:')) evtName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      let data: unknown;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      yield { type: evtName, data } as AskEvent;
    }
  }
}

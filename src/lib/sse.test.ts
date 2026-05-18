import { describe, it, expect } from 'vitest';
import { encodeSSE, parseSSE, type AskEvent } from './sse';

function makeResponse(parts: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(res: Response): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const e of parseSSE(res)) out.push(e);
  return out;
}

describe('encodeSSE', () => {
  it('encodes a text event', () => {
    const bytes = encodeSSE({ type: 'text', data: 'hello' });
    expect(new TextDecoder().decode(bytes)).toBe('event: text\ndata: "hello"\n\n');
  });

  it('encodes a chunks event with array data', () => {
    const bytes = encodeSSE({ type: 'chunks', data: [1, 2, 3] });
    expect(new TextDecoder().decode(bytes)).toBe('event: chunks\ndata: [1,2,3]\n\n');
  });

  it('encodes a citation event with object data', () => {
    const bytes = encodeSSE({
      type: 'citation',
      data: { chunkId: 7, sourcePath: '/x', section: 'A', quote: 'q' },
    });
    const str = new TextDecoder().decode(bytes);
    expect(str.startsWith('event: citation\ndata: ')).toBe(true);
    expect(str.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(str.split('data: ')[1].trim())).toEqual({
      chunkId: 7,
      sourcePath: '/x',
      section: 'A',
      quote: 'q',
    });
  });
});

describe('parseSSE', () => {
  it('parses a single complete event', async () => {
    const res = makeResponse(['event: text\ndata: "hi"\n\n']);
    expect(await collect(res)).toEqual([{ type: 'text', data: 'hi' }]);
  });

  it('round-trips every AskEvent variant', async () => {
    const inputs: AskEvent[] = [
      { type: 'chunks', data: [1, 2, 3] },
      { type: 'text', data: 'hello world' },
      {
        type: 'citation',
        data: { chunkId: 5, sourcePath: '/p', section: null, quote: 'q' },
      },
      { type: 'done', data: { citations: [] } },
      { type: 'error', data: { message: 'boom' } },
    ];
    const concatenated = inputs.map((e) => new TextDecoder().decode(encodeSSE(e))).join('');
    expect(await collect(makeResponse([concatenated]))).toEqual(inputs);
  });

  it('handles a single event split across multiple reads', async () => {
    const res = makeResponse(['event: tex', 't\nda', 'ta: "hello"\n', '\n']);
    expect(await collect(res)).toEqual([{ type: 'text', data: 'hello' }]);
  });

  it('handles multiple events in one read', async () => {
    const res = makeResponse(['event: text\ndata: "a"\n\nevent: text\ndata: "b"\n\n']);
    expect(await collect(res)).toEqual([
      { type: 'text', data: 'a' },
      { type: 'text', data: 'b' },
    ]);
  });

  it('skips frames with invalid JSON data and continues', async () => {
    const res = makeResponse(['event: text\ndata: not-json\n\nevent: text\ndata: "ok"\n\n']);
    expect(await collect(res)).toEqual([{ type: 'text', data: 'ok' }]);
  });

  it('throws if response has no body', async () => {
    const empty = new Response(null);
    await expect(collect(empty)).rejects.toThrow(/no body/i);
  });
});

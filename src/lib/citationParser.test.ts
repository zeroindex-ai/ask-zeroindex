import { describe, it, expect } from 'vitest';
import { buildCitation, flushBuffer, parseDelta, type ParserState } from './citationParser';
import type { RetrievedChunk } from './types';

const baseChunk: RetrievedChunk = {
  id: 1,
  sourcePath: '/path/file.html',
  section: 'Section A',
  content: '',
  score: 0.9,
  source: 'rerank',
};

describe('parseDelta', () => {
  it('passes plain text through with no markers', () => {
    const state: ParserState = { buffer: '' };
    expect(parseDelta('hello world', state)).toEqual({ text: 'hello world', cited: [] });
    expect(state.buffer).toBe('');
  });

  it('extracts a single complete citation marker', () => {
    const state: ParserState = { buffer: '' };
    const r = parseDelta('see [chunk:5] here', state);
    expect(r.cited).toEqual([5]);
    expect(r.text).toBe('see  here');
    expect(state.buffer).toBe('');
  });

  it('buffers a trailing partial marker until completion', () => {
    const state: ParserState = { buffer: '' };
    const r1 = parseDelta('hi [chu', state);
    expect(r1.text).toBe('hi ');
    expect(r1.cited).toEqual([]);
    expect(state.buffer).toBe('[chu');

    const r2 = parseDelta('nk:42] there', state);
    expect(r2.text).toBe(' there');
    expect(r2.cited).toEqual([42]);
    expect(state.buffer).toBe('');
  });

  it('handles multiple markers in one delta', () => {
    const state: ParserState = { buffer: '' };
    const r = parseDelta('a [chunk:1] b [chunk:2] c', state);
    expect(r.cited).toEqual([1, 2]);
    expect(r.text).toBe('a  b  c');
  });

  it('flushes literal "[" text once it cannot be a marker', () => {
    const state: ParserState = { buffer: '' };
    // Long enough after the [ that it cannot still become a [chunk:N] marker
    const r = parseDelta('see [definitely not a marker] here', state);
    expect(r.text).toContain('[definitely not a marker]');
    expect(r.cited).toEqual([]);
    expect(state.buffer).toBe('');
  });

  it('keeps trailing "[" buffered when within lookahead window', () => {
    const state: ParserState = { buffer: '' };
    const r = parseDelta('text [c', state);
    expect(r.text).toBe('text ');
    expect(state.buffer).toBe('[c');
  });
});

describe('flushBuffer', () => {
  it('returns and clears the buffer contents', () => {
    const state: ParserState = { buffer: '[partial' };
    expect(flushBuffer(state)).toBe('[partial');
    expect(state.buffer).toBe('');
  });

  it('returns empty string when buffer is empty', () => {
    const state: ParserState = { buffer: '' };
    expect(flushBuffer(state)).toBe('');
    expect(state.buffer).toBe('');
  });
});

describe('buildCitation', () => {
  it('uses content verbatim when within QUOTE_MAX_CHARS (160)', () => {
    const c = buildCitation({ ...baseChunk, content: 'short content' });
    expect(c.quote).toBe('short content');
  });

  it('truncates with ellipsis when content exceeds 160 chars', () => {
    const long = 'x'.repeat(200);
    const c = buildCitation({ ...baseChunk, content: long });
    expect(c.quote.endsWith('…')).toBe(true);
    // Truncated to 160 chars max + ellipsis (1 char)
    expect([...c.quote].length).toBeLessThanOrEqual(161);
  });

  it('preserves chunkId and section', () => {
    const c = buildCitation({ ...baseChunk, content: 'x' });
    expect(c).toMatchObject({
      chunkId: 1,
      section: 'Section A',
    });
  });

  it('does not leak sourcePath to the client citation', () => {
    const c = buildCitation({ ...baseChunk, content: 'x' });
    expect(c).not.toHaveProperty('sourcePath');
  });

  it('handles null section', () => {
    const c = buildCitation({ ...baseChunk, section: null, content: 'x' });
    expect(c.section).toBe(null);
  });

  it('does not add ellipsis when content is exactly 160 chars', () => {
    const exact = 'x'.repeat(160);
    const c = buildCitation({ ...baseChunk, content: exact });
    expect(c.quote).toBe(exact);
    expect(c.quote.endsWith('…')).toBe(false);
  });
});

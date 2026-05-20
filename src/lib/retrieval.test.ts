import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db', () => ({
  db: vi.fn(),
}));
vi.mock('./embeddings', () => ({
  embedQuery: vi.fn(),
  rerank: vi.fn(),
}));

import { sanitizeFtsQuery, hybridSearch } from './retrieval';
import { db } from './db';
import { embedQuery, rerank } from './embeddings';

describe('sanitizeFtsQuery', () => {
  it('returns "" for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('""');
  });

  it('returns "" when only stop chars / single letters remain', () => {
    expect(sanitizeFtsQuery('a b c')).toBe('""'); // length-1 tokens dropped
    expect(sanitizeFtsQuery('!@#$%')).toBe('""');
  });

  it('quotes each multi-letter token and joins with OR', () => {
    expect(sanitizeFtsQuery('what services')).toBe('"what" OR "services"');
  });

  it('lowercases tokens', () => {
    expect(sanitizeFtsQuery('WHAT Services')).toBe('"what" OR "services"');
  });

  it('strips FTS5 operators and punctuation', () => {
    expect(sanitizeFtsQuery('AND OR NOT NEAR + - "')).toBe('"and" OR "or" OR "not" OR "near"');
  });

  it('strips question mark from end of query', () => {
    expect(sanitizeFtsQuery('What is RAG?')).toBe('"what" OR "is" OR "rag"');
  });

  it('drops single-character tokens', () => {
    expect(sanitizeFtsQuery('a foo b bar c')).toBe('"foo" OR "bar"');
  });

  it('handles whitespace-heavy input', () => {
    expect(sanitizeFtsQuery('  what    services  ')).toBe('"what" OR "services"');
  });
});

describe('hybridSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dedupes overlapping ids and reranks the union', async () => {
    const execute = vi.fn(({ sql }: { sql: string }) => {
      if (sql.includes('vector_top_k')) {
        return Promise.resolve({
          rows: [
            { id: 1, source_path: '/a', section: 's1', content: 'A1', dist: 0.1 },
            { id: 2, source_path: '/a', section: 's2', content: 'A2', dist: 0.2 },
          ],
        });
      }
      if (sql.includes('chunks_fts MATCH')) {
        return Promise.resolve({
          rows: [
            { id: 2, source_path: '/a', section: 's2', content: 'A2', score: -1.0 },
            { id: 3, source_path: '/a', section: 's3', content: 'A3', score: -0.5 },
          ],
        });
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    vi.mocked(db).mockReturnValue({ execute } as unknown as ReturnType<typeof db>);
    vi.mocked(embedQuery).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(rerank).mockResolvedValue([
      { index: 0, score: 0.95 },
      { index: 2, score: 0.85 },
      { index: 1, score: 0.75 },
    ]);

    const result = await hybridSearch('test query');

    // Rerank received the 3 unique candidates (id 2 deduped)
    // rerank was called exactly once above, so calls[0] is present.
    const rerankCall = vi.mocked(rerank).mock.calls[0]!;
    expect(rerankCall[1]).toHaveLength(3);

    // Result has 3 items, all marked as 'rerank' source
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.source === 'rerank')).toBe(true);
    expect(result.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it('preserves rerank order via index mapping back to candidates', async () => {
    const execute = vi.fn(({ sql }: { sql: string }) => {
      if (sql.includes('vector_top_k')) {
        return Promise.resolve({
          rows: [
            { id: 10, source_path: '/x', section: 'A', content: 'first', dist: 0.1 },
            { id: 20, source_path: '/x', section: 'B', content: 'second', dist: 0.2 },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    vi.mocked(db).mockReturnValue({ execute } as unknown as ReturnType<typeof db>);
    vi.mocked(embedQuery).mockResolvedValue([0.1]);
    // Rerank returns index 1 first (id 20), then index 0 (id 10)
    vi.mocked(rerank).mockResolvedValue([
      { index: 1, score: 0.99 },
      { index: 0, score: 0.5 },
    ]);

    const result = await hybridSearch('q');
    expect(result.map((r) => r.id)).toEqual([20, 10]);
    // result has exactly 2 items per the assertion above.
    expect(result[0]!.score).toBe(0.99);
    expect(result[1]!.score).toBe(0.5);
  });

  it('returns empty array when retrieval finds nothing (skips rerank)', async () => {
    const execute = vi.fn(() => Promise.resolve({ rows: [] }));
    vi.mocked(db).mockReturnValue({ execute } as unknown as ReturnType<typeof db>);
    vi.mocked(embedQuery).mockResolvedValue([0.1]);

    const result = await hybridSearch('q');
    expect(result).toEqual([]);
    expect(rerank).not.toHaveBeenCalled();
  });
});

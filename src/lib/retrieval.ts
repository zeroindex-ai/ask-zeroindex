import { db } from './db';
import { embedQuery, rerank } from './embeddings';
import type { RetrievedChunk } from './types';

const VECTOR_TOP_K = 12;
const FTS_TOP_K = 12;
const RERANK_TOP_K = 5;

export async function vectorSearch(query: string, limit = VECTOR_TOP_K): Promise<RetrievedChunk[]> {
  const q = await embedQuery(query);
  const c = db();
  const rs = await c.execute({
    sql: `
      SELECT chunks.id, chunks.source_path, chunks.section, chunks.content,
             vector_distance_cos(chunks.embedding, vector32(?)) AS dist
      FROM vector_top_k('idx_chunks_vec', vector32(?), ?) AS v
      JOIN chunks ON chunks.id = v.id
    `,
    args: [JSON.stringify(q), JSON.stringify(q), limit],
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    sourcePath: String(r.source_path),
    section: r.section ? String(r.section) : null,
    content: String(r.content),
    score: 1 - Number(r.dist),
    source: 'vector' as const,
  }));
}

// FTS5 MATCH doesn't accept bound parameters reliably in libsql — sanitize the
// user query (strip FTS5-special chars, quote each token) and interpolate inline.
export function sanitizeFtsQuery(q: string): string {
  const tokens = q
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export async function ftsSearch(query: string, limit = FTS_TOP_K): Promise<RetrievedChunk[]> {
  const ftsQuery = sanitizeFtsQuery(query);
  const c = db();
  const rs = await c.execute({
    sql: `
      SELECT chunks.id, chunks.source_path, chunks.section, chunks.content,
             bm25(chunks_fts) AS score
      FROM chunks_fts
      JOIN chunks ON chunks.id = chunks_fts.rowid
      WHERE chunks_fts MATCH '${ftsQuery.replace(/'/g, "''") /* belt-and-suspenders; sanitizeFtsQuery already strips quotes */}'
      ORDER BY score
      LIMIT ?
    `,
    args: [limit],
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    sourcePath: String(r.source_path),
    section: r.section ? String(r.section) : null,
    content: String(r.content),
    score: -Number(r.score),
    source: 'fts' as const,
  }));
}

// Union of vector + FTS results, deduped by chunk id. Exported so the eval
// harness can rerun the unioned candidate set against alternative rerankers
// without duplicating the dedupe logic.
export async function hybridCandidates(query: string): Promise<RetrievedChunk[]> {
  const [vec, fts] = await Promise.all([vectorSearch(query), ftsSearch(query)]);
  const byId = new Map<number, RetrievedChunk>();
  for (const r of [...vec, ...fts]) byId.set(r.id, r);
  return Array.from(byId.values());
}

// Hybrid: union vector + FTS results, then rerank with Voyage rerank-2.5.
export async function hybridSearch(query: string, topK = RERANK_TOP_K): Promise<RetrievedChunk[]> {
  const candidates = await hybridCandidates(query);
  if (candidates.length === 0) return [];
  const reranked = await rerank(
    query,
    candidates.map((c) => c.content),
    topK
  );
  // r.index is an index into the documents array we sent the reranker (i.e.
  // candidates). Bounds-guard rather than trust the upstream response: a
  // malformed index would otherwise spread `undefined` into the result.
  return reranked.flatMap((r): RetrievedChunk[] => {
    const candidate = candidates[r.index];
    if (!candidate) return [];
    return [{ ...candidate, score: r.score, source: 'rerank' as const }];
  });
}

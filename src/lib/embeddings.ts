import { requireEnv } from './env';
import { MODELS } from './models';

const VOYAGE_BASE = 'https://api.voyageai.com/v1';
const EMBEDDING_MODEL = MODELS.embeddings;
const RERANK_MODEL = MODELS.rerank;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Retry on transient errors (fetch network throws, 5xx) but never on 4xx —
// those are deterministic (auth, quota, validation) and won't get better.
async function voyagePost<T>(path: string, body: unknown): Promise<T> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${VOYAGE_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requireEnv('VOYAGE_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json() as Promise<T>;
      const detail = await res.text().catch(() => '');
      console.error(`Voyage ${path} failed: ${res.status}`, detail);
      // 4xx is final; 5xx retries.
      if (res.status < 500) throw new Error(`Voyage ${path} failed: ${res.status}`);
      if (attempt === MAX_ATTEMPTS) throw new Error(`Voyage ${path} failed: ${res.status}`);
    } catch (e) {
      // Only network errors (fetch throws TypeError) and our own 5xx throws
      // above retry; anything else (e.g. AbortError, programmer errors) bubbles.
      const isRetryable =
        e instanceof TypeError ||
        (e instanceof Error && /Voyage .* \d{3}$/.test(e.message) && /5\d{2}$/.test(e.message));
      if (!isRetryable || attempt === MAX_ATTEMPTS) throw e;
    }
    await sleep(1000 * attempt);
  }
  // Unreachable: the loop either returns, throws, or sleeps and continues.
  throw new Error(`Voyage ${path} retry loop fell through`);
}

type EmbedResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
};

async function embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const res = await voyagePost<EmbedResponse>('/embeddings', {
    input: texts,
    model: EMBEDDING_MODEL,
    input_type: inputType,
  });
  // Voyage returns an `index` per item and does not guarantee response order
  // matches input order. Sort by index before dropping it, so each embedding
  // lines up with its source text (and, for embedQueries, its cache write).
  return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, 'document');
}

// Process-local cache so repeat queries in the same run don't re-bill Voyage.
// Keyed by raw query text since voyage-3 query embeddings are deterministic.
const _queryEmbedCache = new Map<string, number[]>();
const _queryEmbedCacheMax = 256;

function _writeCache(text: string, vector: number[]): void {
  if (_queryEmbedCache.size >= _queryEmbedCacheMax) {
    const oldest = _queryEmbedCache.keys().next().value;
    if (oldest !== undefined) _queryEmbedCache.delete(oldest);
  }
  _queryEmbedCache.set(text, vector);
}

export async function embedQuery(text: string): Promise<number[]> {
  const cached = _queryEmbedCache.get(text);
  if (cached) return cached;
  const [vector] = await embed([text], 'query');
  // embed() returns one vector per input; we passed exactly one text, so the
  // first element is always present. Guard for type-narrowing regardless.
  if (!vector) throw new Error('Voyage returned no embedding for query');
  _writeCache(text, vector);
  return vector;
}

// Batch variant — embeds many query texts in a single API call. Skips items
// already cached and dedupes within the batch. Useful for warming a known set.
export async function embedQueries(texts: string[]): Promise<number[][]> {
  const uncached = Array.from(new Set(texts.filter((t) => !_queryEmbedCache.has(t))));
  if (uncached.length > 0) {
    const fresh = await embed(uncached, 'query');
    uncached.forEach((t, i) => {
      const vector = fresh[i];
      // embed() returns exactly one vector per input text, index-aligned, so
      // fresh[i] is always present for every i in uncached. Guard anyway.
      if (vector) _writeCache(t, vector);
    });
  }
  return texts.map((t) => {
    const vector = _queryEmbedCache.get(t);
    // Every text is either pre-cached or written above, so this is populated.
    if (!vector) throw new Error('Voyage returned no embedding for query');
    return vector;
  });
}

type RerankResponse = {
  data: Array<{ index: number; relevance_score: number }>;
};

export async function rerank(
  query: string,
  documents: string[],
  topK = 5
): Promise<Array<{ index: number; score: number }>> {
  const res = await voyagePost<RerankResponse>('/rerank', {
    query,
    documents,
    model: RERANK_MODEL,
    top_k: topK,
  });
  return res.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}

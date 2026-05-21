export type Chunk = {
  id: number;
  sourcePath: string;
  section: string | null;
  content: string;
};

export type RetrievedChunk = Chunk & {
  score: number;
  source: 'vector' | 'fts' | 'rerank';
};

// NOTE: deliberately excludes sourcePath. The internal RetrievedChunk keeps it
// for server-side prompt grounding, but the source path is the local ingest
// path (e.g. /Users/.../index.html) and must never reach the client payload.
export type Citation = {
  chunkId: number;
  section: string | null;
  quote: string;
};

export type AnswerResponse = {
  answer: string;
  citations: Citation[];
  retrievedChunkIds: number[];
};

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

export type Citation = {
  chunkId: number;
  sourcePath: string;
  section: string | null;
  quote: string;
};

export type AnswerResponse = {
  answer: string;
  citations: Citation[];
  retrievedChunkIds: number[];
};

// Single source of truth for vendor model IDs. Bumping any one model is a
// one-line edit here; callers re-export or import directly.

export const MODELS = {
  answer: 'claude-sonnet-4-6',
  embeddings: 'voyage-3',
  rerank: 'rerank-2.5',
} as const;

export type ModelKey = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[ModelKey];

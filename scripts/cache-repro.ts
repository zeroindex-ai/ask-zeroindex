// Run same query 3 times via answer(). Check whether a "warmup" heuristic
// engages caching after seeing the same request twice.
// Run: pnpm tsx --env-file=.env.local scripts/cache-repro.ts

import { answer } from '@/lib/claude';
import type { RetrievedChunk } from '@/lib/types';
import { runMain } from './_run';

const MOCK_CHUNKS: RetrievedChunk[] = Array.from({ length: 5 }, (_, i) => ({
  id: 100 + i,
  sourcePath: '/Users/Abhishek/Desktop/ZeroIndex/Code/zeroindexai/index.html',
  section: `Section ${i}`,
  content:
    `Filler chunk ${i}: ZeroIndex is a single-person AI consultancy run by Abhishek Bhandari. ` +
    'Long enough to make the combined context substantive. '.repeat(8),
  score: 0.9 - i * 0.05,
  source: 'rerank' as const,
}));

const Q = 'What does this consultancy do?';

async function once(label: string) {
  const stream = await answer(Q, MOCK_CHUNKS);
  const m = await stream.finalMessage();
  const u = m.usage;
  console.log(
    `  ${label}  input=${String(u.input_tokens).padStart(5)}  cache_w=${String(u.cache_creation_input_tokens ?? 0).padStart(5)}  cache_r=${String(u.cache_read_input_tokens ?? 0).padStart(5)}`
  );
}

async function main() {
  console.log('Three identical answer() calls (same question, same chunks):');
  await once('Call 1:');
  await once('Call 2:');
  await once('Call 3:');
}

runMain(main);

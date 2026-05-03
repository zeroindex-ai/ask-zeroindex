// Direct end-to-end test: hybridSearch → Claude answer stream.
// Run: pnpm tsx --env-file=.env.local scripts/ask.ts "your question"

import { hybridSearch } from '@/lib/retrieval';
import { answer } from '@/lib/claude';
import { runMain } from './_run';

async function main() {
  const question = process.argv[2] ?? 'What services does ZeroIndex offer?';
  console.log(`Q: ${question}\n`);

  const t0 = Date.now();
  const chunks = await hybridSearch(question);
  const tRetrieval = Date.now() - t0;

  const stream = await answer(question, chunks);
  process.stdout.write('A: ');
  let firstTokenAt = 0;
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (!firstTokenAt) firstTokenAt = Date.now() - t0;
      process.stdout.write(event.delta.text);
    }
  }
  const tTotal = Date.now() - t0;

  console.log('\n');
  console.log(`[retrieval: ${tRetrieval}ms · first token: ${firstTokenAt}ms · total: ${tTotal}ms]`);
  console.log(`[chunks: ${chunks.map((c) => c.id).join(', ')}]`);
}

runMain(main);

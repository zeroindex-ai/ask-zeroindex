// Cache stats: run 5 queries through the full pipeline and report
// per-query Anthropic cache usage. Validates that prompt caching is wired
// correctly and surfaces the ratio between cache writes vs reads.
// Run: pnpm tsx --env-file=.env.local scripts/cache-stats.ts
//
// Why 5 queries: keeps total runtime under Anthropic's 5-minute prompt cache
// TTL so subsequent queries can read from the cache the first one wrote.

import { hybridSearch } from '@/lib/retrieval';
import { answer } from '@/lib/claude';
import { runMain, sleep, RERANK_THROTTLE_MS, pad } from './_run';

const QUERIES = [
  'What services does ZeroIndex offer?',
  'How does pricing work?',
  'Tell me about Abhishek.',
  'How does an engagement start?',
  'What technologies do you use?',
];

// Sonnet 4.6 rate card, US dollars per 1M tokens.
const PRICE = {
  input: 3,
  cacheRead: 0.3,
  cacheWrite: 3.75,
  output: 15,
} as const;

async function main() {
  console.log(`Cache stats: ${QUERIES.length} queries\n`);

  const header =
    pad('query', 38) +
    pad('input', 8, 'start') +
    pad('cache_w', 9, 'start') +
    pad('cache_r', 9, 'start') +
    pad('output', 8, 'start');
  console.log(header);
  console.log('-'.repeat(header.length));

  let totalInput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;

  for (const [i, q] of QUERIES.entries()) {
    if (i > 0 && RERANK_THROTTLE_MS > 0) await sleep(RERANK_THROTTLE_MS);
    const chunks = await hybridSearch(q);
    const stream = await answer(q, chunks);
    // finalMessage() drains the stream internally; no explicit for-await needed.
    const final = await stream.finalMessage();
    const u = final.usage;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;

    console.log(
      pad(q.length > 36 ? q.slice(0, 35) + '…' : q, 38) +
        pad(u.input_tokens, 8, 'start') +
        pad(cacheWrite, 9, 'start') +
        pad(cacheRead, 9, 'start') +
        pad(u.output_tokens, 8, 'start')
    );

    totalInput += u.input_tokens;
    totalCacheWrite += cacheWrite;
    totalCacheRead += cacheRead;
    totalOutput += u.output_tokens;
  }

  console.log('-'.repeat(header.length));
  console.log(
    pad('TOTAL', 38) +
      pad(totalInput, 8, 'start') +
      pad(totalCacheWrite, 9, 'start') +
      pad(totalCacheRead, 9, 'start') +
      pad(totalOutput, 8, 'start')
  );

  // Cache hit rate: read tokens / (read + write) over the cacheable surface
  // we actually saw. When neither caching path engages (our current case at
  // 1024-token threshold), this is 0% by definition.
  const cacheable = totalCacheRead + totalCacheWrite;
  const hitRate = cacheable > 0 ? (totalCacheRead / cacheable) * 100 : 0;
  console.log(`\nCache hit rate: ${hitRate.toFixed(1)}% (${totalCacheRead} read / ${cacheable} cacheable)`);

  const cost =
    (totalInput * PRICE.input +
      totalCacheRead * PRICE.cacheRead +
      totalCacheWrite * PRICE.cacheWrite +
      totalOutput * PRICE.output) /
    1_000_000;
  const costNoCache =
    ((totalInput + totalCacheRead + totalCacheWrite) * PRICE.input + totalOutput * PRICE.output) / 1_000_000;
  const savingsPct = ((costNoCache - cost) / costNoCache) * 100;
  console.log(`Estimated cost (this run, Sonnet 4.6): $${cost.toFixed(5)}`);
  console.log(
    `Without caching:                            $${costNoCache.toFixed(5)} (${savingsPct.toFixed(1)}% saved)`
  );
}

runMain(main);

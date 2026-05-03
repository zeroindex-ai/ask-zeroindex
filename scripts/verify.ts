// Sanity check the ingest: count chunks, show samples, run a test retrieval.
// Run: pnpm tsx --env-file=.env.local scripts/verify.ts

import { db } from '@/lib/db';
import { hybridSearch } from '@/lib/retrieval';
import { runMain } from './_run';

async function main() {
  const c = db();

  const count = await c.execute('SELECT COUNT(*) as n FROM chunks');
  console.log(`chunks table: ${count.rows[0].n} rows`);

  const ftsCount = await c.execute('SELECT COUNT(*) as n FROM chunks_fts');
  console.log(`chunks_fts:   ${ftsCount.rows[0].n} rows`);

  console.log('\n--- first 3 chunks ---');
  const sample = await c.execute('SELECT id, section, substr(content, 1, 120) as preview FROM chunks LIMIT 3');
  for (const r of sample.rows) {
    console.log(`[${r.id}] ${r.section}\n  ${r.preview}...`);
  }

  console.log('\n--- test retrieval: "What services do you offer?" ---');
  const results = await hybridSearch('What services do you offer?', 3);
  for (const r of results) {
    console.log(`[${r.id}] score=${r.score.toFixed(3)} section="${r.section}"\n  ${r.content.slice(0, 120)}...`);
  }
}

runMain(main);

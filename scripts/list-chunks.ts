// One-off: dump all chunks for golden-seed authoring.
// Run: pnpm tsx --env-file=.env.local scripts/list-chunks.ts

import { db } from '@/lib/db';
import { runMain } from './_run';

const PREVIEW_CHARS = 240;

async function main() {
  const c = db();
  const r = await c.execute(
    `SELECT id, section, substr(content, 1, ${PREVIEW_CHARS}) AS preview, length(content) AS len
     FROM chunks
     ORDER BY id`
  );
  for (const row of r.rows) {
    const truncated = Number(row.len) > PREVIEW_CHARS;
    console.log(`[${row.id}] ${row.section}`);
    console.log(`  ${row.preview}${truncated ? '...' : ''}`);
    console.log('');
  }
}

runMain(main);

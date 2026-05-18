// Smoke test: verifies all 4 env keys connect to their respective services.
// Run: pnpm tsx --env-file=.env.local scripts/smoke.ts

import Anthropic from '@anthropic-ai/sdk';
import { db, initSchema, EMBEDDING_DIM } from '@/lib/db';
import { embedQuery } from '@/lib/embeddings';
import { ANSWER_MODEL } from '@/lib/claude';
import { errMsg } from '@/lib/errors';
import { runMain } from './_run';

async function main() {
  const results: Array<[string, 'OK' | string]> = [];

  // 1. Turso — connect + init schema + select 1
  try {
    await initSchema();
    const r = await db().execute('SELECT 1 AS one');
    results.push(['Turso', r.rows.length === 1 ? 'OK' : `unexpected: ${JSON.stringify(r.rows)}`]);
  } catch (e) {
    results.push(['Turso', `FAIL: ${errMsg(e)}`]);
  }

  // 2. Voyage — embed a test string
  try {
    const v = await embedQuery('hello');
    const ok = v.length === EMBEDDING_DIM;
    results.push(['Voyage', ok ? `OK (${v.length} dims)` : `FAIL: ${v.length} dims`]);
  } catch (e) {
    results.push(['Voyage', `FAIL: ${errMsg(e)}`]);
  }

  // 3. Anthropic — single-token completion
  try {
    const a = new Anthropic();
    const m = await a.messages.create({
      model: ANSWER_MODEL,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
    });
    const text = m.content[0].type === 'text' ? m.content[0].text : '';
    results.push([
      'Anthropic',
      text.toLowerCase().includes('ok') ? `OK (${text.trim()})` : `FAIL: got "${text}"`,
    ]);
  } catch (e) {
    results.push(['Anthropic', `FAIL: ${errMsg(e)}`]);
  }

  console.log('');
  console.log('Smoke test results:');
  for (const [k, v] of results) {
    console.log(`  ${k.padEnd(10)} ${v}`);
  }

  const failed = results.filter(([, v]) => !v.startsWith('OK')).length;
  process.exit(failed === 0 ? 0 : 1);
}

runMain(main);

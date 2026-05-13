// Eval harness: runs the golden Q/A set through the full RAG pipeline
// and grades each item via programmatic checks + Claude judge.
//
// Run: pnpm tsx --env-file=.env.local evals/run.ts                (all 30)
//      pnpm tsx --env-file=.env.local evals/run.ts positive 5     (5 positives)
//      pnpm tsx --env-file=.env.local evals/run.ts adversarial    (all adversarial)
//
// Powered by @zeroindex-ai/eval-pack (this project's reference consumer).

import { readFile } from 'node:fs/promises';
import {
  runEval,
  mustMention,
  mustNotMention,
  citationCount,
  markerCitationExtractor,
  p50,
  p95,
} from '@zeroindex-ai/eval-pack';
import { claudeJudge } from '@zeroindex-ai/eval-pack/judge-claude';
import { hybridSearch } from '@/lib/retrieval';
import { embedQueries } from '@/lib/embeddings';
import { answer, ANSWER_MODEL } from '@/lib/claude';
import { runMain, RERANK_THROTTLE_MS, pad } from '../scripts/_run';

type Category = 'positive' | 'negative' | 'adversarial' | 'multi-part';

async function subject(question: string) {
  const t0 = Date.now();
  const chunks = await hybridSearch(question);
  const retrievalMs = Date.now() - t0;

  const stream = await answer(question, chunks);
  let firstTokenMs = 0;
  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (firstTokenMs === 0) firstTokenMs = Date.now() - t0;
      text += event.delta.text;
    }
  }

  return {
    text,
    retrievedRefs: chunks.map((c) => String(c.id)),
    metadata: { retrievalMs, firstTokenMs },
  };
}

async function main(): Promise<void> {
  const onlyCategory = process.argv[2] as Category | undefined;
  const limit = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

  // Pre-warm query embeddings so retrieval sees cache hits.
  const raw = await readFile('evals/golden-seed.json', 'utf-8');
  const golden = JSON.parse(raw) as {
    version: '1.0';
    items: Array<{ question: string; category: Category }>;
  };
  const subset = onlyCategory
    ? golden.items.filter((i) => i.category === onlyCategory)
    : golden.items;
  const items = limit ? subset.slice(0, limit) : subset;

  console.log(`Eval: ${items.length} items · model: ${ANSWER_MODEL}\n`);
  process.stdout.write('  pre-warming query embeddings ... ');
  const tWarm = Date.now();
  await embedQueries(items.map((g) => g.question));
  console.log(`done (${Date.now() - tWarm}ms)`);

  const report = await runEval({
    golden: 'evals/golden-seed.json',
    subject,
    citationExtractor: markerCitationExtractor(/\[chunk:(\d+)\]/g),
    checks: [
      mustMention(),
      mustNotMention(),
      citationCount({ min: 1, skipWhen: (item) => item.expect_refusal === true }),
    ],
    judge: claudeJudge({ model: ANSWER_MODEL }),
    throttleMs: RERANK_THROTTLE_MS,
    resultsDir: 'evals/results',
    filter: {
      ...(onlyCategory !== undefined ? { category: onlyCategory } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    onItem: (e) => {
      if (e.type === 'start') {
        process.stdout.write(
          `  [${pad(e.index + 1, 2, 'start')}/${e.total}] ${pad(e.item.id, 30)} `,
        );
      } else if (e.type === 'pass') {
        console.log(`✓ (${e.result.timings.totalMs}ms)`);
      } else if (e.type === 'fail') {
        console.log(`✗ (${e.result.timings.totalMs}ms)`);
      } else if (e.type === 'error') {
        console.log(`ERROR: ${e.error.message}`);
      }
    },
  });

  // Aggregate by category for the summary table.
  const byCategory = report.results.reduce<
    Record<string, { passed: number; total: number; latencies: number[] }>
  >((acc, r) => {
    const entry = acc[r.category] ?? { passed: 0, total: 0, latencies: [] };
    entry.total += 1;
    if (r.pass) entry.passed += 1;
    entry.latencies.push(r.timings.totalMs);
    acc[r.category] = entry;
    return acc;
  }, {});

  console.log('\n=== Pass rate by category ===\n');
  console.log(pad('category', 16) + pad('pass rate', 18) + pad('p50', 10) + 'p95');
  console.log('-'.repeat(65));
  for (const [cat, e] of Object.entries(byCategory)) {
    const pct = Math.round((e.passed / e.total) * 100);
    console.log(
      pad(cat, 16) +
        pad(`${e.passed}/${e.total} (${pct}%)`, 18) +
        pad(`${p50(e.latencies)}ms`, 10) +
        `${p95(e.latencies)}ms`,
    );
  }
  const totalPass = report.results.filter((r) => r.pass).length;
  const total = report.results.length;
  const totalPct = total > 0 ? Math.round((totalPass / total) * 100) : 0;
  console.log('-'.repeat(65));
  console.log(pad('TOTAL', 16) + pad(`${totalPass}/${total} (${totalPct}%)`, 18));

  if (report.errors.length > 0) {
    console.log(`\n=== Errors (${report.errors.length}) ===\n`);
    for (const e of report.errors) console.log(`  [${e.id}] ${e.error}`);
  }

  const failures = report.results.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log(`\n=== Failures (${failures.length}) ===\n`);
    for (const r of failures) {
      console.log(`[${r.id}] ${r.category} — "${r.question}"`);
      for (const c of r.checks.filter((c) => !c.ok)) {
        const detail = c.detail !== undefined ? ` ${JSON.stringify(c.detail)}` : '';
        console.log(`  - check ${c.name} failed${detail}`);
      }
      if (r.judgment !== null && r.judgment.appropriate !== 'yes') {
        console.log(
          `  - judge appropriate=${r.judgment.appropriate}: ${r.judgment.reason}`,
        );
      }
      if (r.judgment !== null && r.judgment.grounded === 'no') {
        console.log(`  - judge grounded=no`);
      }
    }
  }

  if (report.jsonPath !== undefined) console.log(`\nSaved: ${report.jsonPath}`);

  if (report.results.length === 0) {
    throw new Error('No eval results — every item errored out');
  }

  const threshold = Number(process.env['EVAL_PASS_THRESHOLD'] ?? 0.8);
  const passRate = totalPass / report.results.length;
  if (passRate < threshold) {
    throw new Error(
      `Pass rate ${(passRate * 100).toFixed(1)}% below threshold ${(threshold * 100).toFixed(0)}%`,
    );
  }
}

runMain(main);

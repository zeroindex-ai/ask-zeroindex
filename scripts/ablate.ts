// Retrieval ablation: run each query in the golden seed through every
// retrieval mode, measure Recall@K + latency. Output a comparison table.
// Run: pnpm tsx --env-file=.env.local scripts/ablate.ts
//
// Rate-limit note: Voyage free tier is 3 RPM. We cache query embeddings
// (batched warm-up) and rerank once at top-8 per query, slicing for top-3 /
// top-5, so a 13-query run hits Voyage ~14 times (≈5 min on free tier).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embedQueries, rerank } from '@/lib/embeddings';
import { vectorSearch, ftsSearch, hybridCandidates } from '@/lib/retrieval';
import { recall, p50, p95 } from '@zeroindex-ai/eval-pack';
import { runMain, sleep, RERANK_THROTTLE_MS, pad } from './_run';

type GoldenItem = {
  id: string;
  question: string;
  relevant_refs: string[];
  must_mention: string[];
  must_not_mention: string[];
};

const MODE_NAMES = [
  'vector-only top-5',
  'fts-only top-5',
  'hybrid+rerank top-3',
  'hybrid+rerank top-5',
  'hybrid+rerank top-8',
] as const;
type ModeName = (typeof MODE_NAMES)[number];

type RunResult = { ids: number[]; latency: number; recall: number };

async function main() {
  const raw = await readFile(join(process.cwd(), 'evals/golden-seed.json'), 'utf-8');
  const goldenSet: { version: '1.0'; items: GoldenItem[] } = JSON.parse(raw);
  const golden = goldenSet.items;

  const grid: Record<ModeName, Record<string, RunResult>> = Object.fromEntries(
    MODE_NAMES.map((m) => [m, {}])
  ) as Record<ModeName, Record<string, RunResult>>;

  console.log(`Ablation: ${golden.length} queries × ${MODE_NAMES.length} modes\n`);

  process.stdout.write('  pre-warming query embeddings ... ');
  const tWarm = Date.now();
  await embedQueries(golden.map((g) => g.question));
  console.log(`done (${Date.now() - tWarm}ms)`);

  for (const [i, item] of golden.entries()) {
    process.stdout.write(`  ${item.id} ... `);

    if (i > 0 && RERANK_THROTTLE_MS > 0) await sleep(RERANK_THROTTLE_MS);

    // The three retrieval kicks-offs are independent — fan them out.
    const [vec5, fts5, candidates] = await Promise.all([
      timed(() => vectorSearch(item.question, 5)),
      timed(() => ftsSearch(item.question, 5)),
      timed(() => hybridCandidates(item.question)),
    ]);
    const tRerank = Date.now();
    const reranked =
      candidates.value.length > 0
        ? await rerank(
            item.question,
            candidates.value.map((c) => c.content),
            8
          )
        : [];
    const hybridLatency = candidates.latency + (Date.now() - tRerank);
    const rerankedIds = reranked
      .map((r) => candidates.value[r.index]?.id)
      .filter((id): id is number => id !== undefined);

    record(
      grid,
      'vector-only top-5',
      item,
      vec5.value.map((r) => r.id),
      vec5.latency
    );
    record(
      grid,
      'fts-only top-5',
      item,
      fts5.value.map((r) => r.id),
      fts5.latency
    );
    record(grid, 'hybrid+rerank top-3', item, rerankedIds.slice(0, 3), hybridLatency);
    record(grid, 'hybrid+rerank top-5', item, rerankedIds.slice(0, 5), hybridLatency);
    record(grid, 'hybrid+rerank top-8', item, rerankedIds.slice(0, 8), hybridLatency);

    process.stdout.write('done\n');
  }

  printPerQuery(golden, grid);
  printAggregates(golden, grid);
  printMisses(golden, grid);
}

function record(
  grid: Record<ModeName, Record<string, RunResult>>,
  mode: ModeName,
  item: GoldenItem,
  ids: number[],
  latency: number
) {
  grid[mode][item.id] = {
    ids,
    latency,
    recall: recall(ids.map(String), item.relevant_refs),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; latency: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, latency: Date.now() - t0 };
}

// The main loop calls record() for every mode × item before any reader runs,
// so the cell is always present. Centralize the lookup + invariant check.
function cellOf(
  grid: Record<ModeName, Record<string, RunResult>>,
  mode: ModeName,
  id: string
): RunResult {
  const cell = grid[mode][id];
  if (!cell) throw new Error(`missing ablation cell for ${mode}/${id}`);
  return cell;
}

function printPerQuery(golden: GoldenItem[], grid: Record<ModeName, Record<string, RunResult>>) {
  console.log('\n=== Recall@K per query ===\n');
  const header = [pad('query', 24), ...MODE_NAMES.map((m) => pad(m, 22))].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const item of golden) {
    const row = [pad(item.id, 24)];
    for (const mode of MODE_NAMES) {
      const { recall } = cellOf(grid, mode, item.id);
      const tag = recall === 1 ? '✓' : recall === 0 ? '✗' : '~';
      row.push(pad(`${tag} ${(recall * 100).toFixed(0)}%`, 22));
    }
    console.log(row.join(' '));
  }
}

function printAggregates(golden: GoldenItem[], grid: Record<ModeName, Record<string, RunResult>>) {
  console.log('\n=== Aggregates ===\n');
  console.log(pad('mode', 28) + pad('mean recall', 15) + pad('p50 latency', 15) + 'p95 latency');
  console.log('-'.repeat(70));
  for (const mode of MODE_NAMES) {
    const cells = golden.map((item) => cellOf(grid, mode, item.id));
    const meanRecall = cells.reduce((a, c) => a + c.recall, 0) / cells.length;
    const latencies = cells.map((c) => c.latency);
    console.log(
      pad(mode, 28) +
        pad(`${(meanRecall * 100).toFixed(1)}%`, 15) +
        pad(`${p50(latencies)}ms`, 15) +
        `${p95(latencies)}ms`
    );
  }
}

function printMisses(golden: GoldenItem[], grid: Record<ModeName, Record<string, RunResult>>) {
  console.log('\n=== Misses on hybrid+rerank top-5 ===\n');
  for (const item of golden) {
    const cell = cellOf(grid, 'hybrid+rerank top-5', item.id);
    const cellIdSet = new Set(cell.ids.map(String));
    const missed = item.relevant_refs.filter((ref) => !cellIdSet.has(ref));
    if (missed.length > 0) {
      console.log(`  ${item.id}: missed [${missed.join(', ')}] — "${item.question}"`);
    }
  }
}

runMain(main);

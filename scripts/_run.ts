// Shared boilerplate for top-level script entry points: standard
// run+catch+exit, plus utilities used across scripts/ and evals/.

import { closeDb } from '@/lib/db';

export function runMain(fn: () => Promise<unknown>): void {
  fn()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(closeDb);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Voyage free tier: 3 RPM. Set to 0 once payment method is added.
export const RERANK_THROTTLE_MS = Number(process.env.RERANK_THROTTLE_MS ?? 21_000);

export function pad(s: string | number, n: number, side: 'end' | 'start' = 'end'): string {
  const str = String(s);
  return side === 'end' ? str.padEnd(n) : str.padStart(n);
}

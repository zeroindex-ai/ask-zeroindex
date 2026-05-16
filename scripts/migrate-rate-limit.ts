// Migration: create the rate_limit_buckets table used by src/lib/rateLimit.ts.
// Idempotent — safe to re-run; uses CREATE TABLE IF NOT EXISTS like initSchema.
// Run: pnpm tsx --env-file=.env.local scripts/migrate-rate-limit.ts

import { db } from '@/lib/db';
import { runMain } from './_run';

async function main(): Promise<void> {
  const c = db();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS rate_limit_buckets (
      key TEXT PRIMARY KEY,
      tokens REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  console.log('✓ rate_limit_buckets table ready');
}

runMain(main);

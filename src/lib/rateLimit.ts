// Turso-backed token bucket for /api/ask. Public endpoint that fans out to
// three paid APIs; without this a botnet trivially drains the budget.
//
// Bucket: capacity 10 tokens, refill 10 tokens / 60s (≈ 0.1667 tokens/sec).
// Keyed by client IP (x-forwarded-for) with a hashed UA + Accept-Language
// fallback for missing-header clients. State is persisted in
// `rate_limit_buckets` (see scripts/migrate-rate-limit.ts).

import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import { db } from './db';

export const BUCKET_CAPACITY = 10;
export const BUCKET_REFILL_PER_SEC = BUCKET_CAPACITY / 60;

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSec: number };

export type RateLimitOptions = {
  // Injected for tests; defaults call the module-level singletons.
  now?: () => number;
  client?: () => Pick<Client, 'execute'>;
  capacity?: number;
  refillPerSec?: number;
};

// Pull the first non-empty IP from a possibly comma-separated x-forwarded-for.
function firstForwardedIp(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.trim();
  return first ? first : null;
}

export function bucketKeyFromHeaders(headers: Headers): string {
  const ip = firstForwardedIp(headers.get('x-forwarded-for'));
  if (ip) return `ip:${ip}`;
  // Fall back to a stable hash of UA + Accept-Language so anonymous clients
  // without a forwarded IP still share a bucket per-fingerprint rather than
  // bypassing the limit entirely.
  const ua = headers.get('user-agent') ?? '';
  const lang = headers.get('accept-language') ?? '';
  const digest = createHash('sha256').update(`${ua}\n${lang}`).digest('hex').slice(0, 16);
  return `fp:${digest}`;
}

// Token-bucket math, isolated for unit testing without a DB.
export function computeNextState(
  currentTokens: number,
  lastUpdatedMs: number,
  nowMs: number,
  capacity: number,
  refillPerSec: number
): { tokens: number; allowed: boolean; retryAfterSec: number } {
  const elapsedSec = Math.max(0, (nowMs - lastUpdatedMs) / 1000);
  const refilled = Math.min(capacity, currentTokens + elapsedSec * refillPerSec);
  if (refilled >= 1) {
    return { tokens: refilled - 1, allowed: true, retryAfterSec: 0 };
  }
  const deficit = 1 - refilled;
  return {
    tokens: refilled,
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil(deficit / refillPerSec)),
  };
}

export async function checkRateLimit(key: string, opts: RateLimitOptions = {}): Promise<RateLimitDecision> {
  const now = opts.now ?? Date.now;
  const c = opts.client ?? db;
  const capacity = opts.capacity ?? BUCKET_CAPACITY;
  const refillPerSec = opts.refillPerSec ?? BUCKET_REFILL_PER_SEC;
  const conn = c();
  const nowMs = now();

  const existing = await conn.execute({
    sql: 'SELECT tokens, updated_at FROM rate_limit_buckets WHERE key = ?',
    args: [key],
  });

  const row = existing.rows[0];
  const currentTokens = row && row.tokens !== null ? Number(row.tokens) : capacity;
  const lastUpdated = row && row.updated_at !== null ? Number(row.updated_at) : nowMs;

  const next = computeNextState(currentTokens, lastUpdated, nowMs, capacity, refillPerSec);

  await conn.execute({
    sql: `
      INSERT INTO rate_limit_buckets (key, tokens, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at
    `,
    args: [key, next.tokens, nowMs],
  });

  if (next.allowed) {
    return { allowed: true, remaining: Math.floor(next.tokens) };
  }
  return { allowed: false, retryAfterSec: next.retryAfterSec };
}

import { describe, it, expect, beforeEach } from 'vitest';
import type { Client } from '@libsql/client';
import {
  bucketKeyFromHeaders,
  checkRateLimit,
  computeNextState,
  BUCKET_CAPACITY,
  BUCKET_REFILL_PER_SEC,
} from './rateLimit';

// Minimal in-memory stand-in for the libsql client. Only implements the
// shape checkRateLimit uses: SELECT by key, INSERT … ON CONFLICT … DO UPDATE.
type Row = { tokens: number; updated_at: number };

function makeFakeClient(): {
  store: Map<string, Row>;
  client: () => Pick<Client, 'execute'>;
} {
  const store = new Map<string, Row>();
  const execute = (async (input: unknown) => {
    const { sql, args } = input as { sql: string; args: unknown[] };
    if (sql.includes('SELECT tokens')) {
      const key = String(args[0]);
      const row = store.get(key);
      return {
        rows: row ? [{ tokens: row.tokens, updated_at: row.updated_at }] : [],
      };
    }
    if (sql.includes('INSERT INTO rate_limit_buckets')) {
      const [key, tokens, updatedAt] = args as [string, number, number];
      store.set(key, { tokens, updated_at: updatedAt });
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  }) as unknown as Client['execute'];
  return {
    store,
    client: () => ({ execute }),
  };
}

describe('bucketKeyFromHeaders', () => {
  it('prefers x-forwarded-for first IP', () => {
    const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(bucketKeyFromHeaders(h)).toBe('ip:1.2.3.4');
  });

  it('falls back to fp hash when x-forwarded-for is absent', () => {
    const h = new Headers({
      'user-agent': 'TestUA/1.0',
      'accept-language': 'en-US',
    });
    const key = bucketKeyFromHeaders(h);
    expect(key.startsWith('fp:')).toBe(true);
    expect(key.length).toBe('fp:'.length + 16);
  });

  it('is stable for the same UA + Accept-Language', () => {
    const h1 = new Headers({ 'user-agent': 'X', 'accept-language': 'en' });
    const h2 = new Headers({ 'user-agent': 'X', 'accept-language': 'en' });
    expect(bucketKeyFromHeaders(h1)).toBe(bucketKeyFromHeaders(h2));
  });

  it('differs across UA values', () => {
    const h1 = new Headers({ 'user-agent': 'A', 'accept-language': 'en' });
    const h2 = new Headers({ 'user-agent': 'B', 'accept-language': 'en' });
    expect(bucketKeyFromHeaders(h1)).not.toBe(bucketKeyFromHeaders(h2));
  });
});

describe('computeNextState', () => {
  it('refills proportionally to elapsed time, capped at capacity', () => {
    // 30s of refill at 10/60 = 5 tokens added to current 2 → 7
    const r = computeNextState(2, 0, 30_000, 10, 10 / 60);
    expect(r.allowed).toBe(true);
    expect(r.tokens).toBeCloseTo(6); // 7 minus 1 spent
  });

  it('does not refill above capacity', () => {
    const r = computeNextState(10, 0, 600_000, 10, 10 / 60);
    expect(r.allowed).toBe(true);
    expect(r.tokens).toBe(9); // capped to 10, minus 1 spent
  });

  it('denies and returns retryAfterSec when refilled tokens < 1', () => {
    const r = computeNextState(0, 0, 1_000, 10, 10 / 60); // 1s ≈ 0.167 tokens
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe('checkRateLimit', () => {
  let fake: ReturnType<typeof makeFakeClient>;
  beforeEach(() => {
    fake = makeFakeClient();
  });

  it('allows the first request and seeds the bucket', async () => {
    const r = await checkRateLimit('ip:1.1.1.1', {
      now: () => 1000,
      client: fake.client,
    });
    expect(r.allowed).toBe(true);
    const row = fake.store.get('ip:1.1.1.1');
    expect(row).toBeDefined();
    // Started full at capacity; one consumed.
    expect(row?.tokens).toBeCloseTo(BUCKET_CAPACITY - 1);
  });

  it('allows up to capacity, then denies with retry-after on the next call', async () => {
    const now = () => 0;
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      const r = await checkRateLimit('ip:2.2.2.2', { now, client: fake.client });
      expect(r.allowed).toBe(true);
    }
    const denied = await checkRateLimit('ip:2.2.2.2', { now, client: fake.client });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps separate buckets per key', async () => {
    const now = () => 0;
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      await checkRateLimit('ip:a', { now, client: fake.client });
    }
    const aDenied = await checkRateLimit('ip:a', { now, client: fake.client });
    expect(aDenied.allowed).toBe(false);

    // Independent key still has a full bucket.
    const bAllowed = await checkRateLimit('ip:b', { now, client: fake.client });
    expect(bAllowed.allowed).toBe(true);
  });

  it('refills over time (drained bucket allows again after enough elapsed)', async () => {
    let t = 0;
    const now = () => t;
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      await checkRateLimit('ip:3.3.3.3', { now, client: fake.client });
    }
    const denied = await checkRateLimit('ip:3.3.3.3', { now, client: fake.client });
    expect(denied.allowed).toBe(false);

    // Advance enough wall-clock for ≥ 1 token to refill: 1 / (10/60) = 6s.
    t += 7_000;
    const allowed = await checkRateLimit('ip:3.3.3.3', { now, client: fake.client });
    expect(allowed.allowed).toBe(true);
  });

  it('uses BUCKET_REFILL_PER_SEC as the documented refill rate', () => {
    expect(BUCKET_REFILL_PER_SEC).toBeCloseTo(10 / 60);
  });
});

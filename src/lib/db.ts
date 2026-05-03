import { createClient, type Client } from '@libsql/client';
import { requireEnv } from './env';

// Cache off globalThis so Next.js dev HMR doesn't leak a fresh libsql client
// per hot reload. Standard Next pattern for module-level singletons.
const globalForDb = globalThis as unknown as { __askZeroindexDb?: Client };

export function db(): Client {
  if (globalForDb.__askZeroindexDb) return globalForDb.__askZeroindexDb;
  globalForDb.__askZeroindexDb = createClient({
    url: requireEnv('TURSO_DATABASE_URL'),
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return globalForDb.__askZeroindexDb;
}

// No-op if the client was never instantiated. Called from runMain's finally
// so scripts don't have to remember to close.
export function closeDb(): void {
  if (globalForDb.__askZeroindexDb) {
    globalForDb.__askZeroindexDb.close();
    globalForDb.__askZeroindexDb = undefined;
  }
}

// Voyage-3 embedding dimension. Schema is bound to this — changing model
// requires a migration.
export const EMBEDDING_DIM = 1024;

export async function initSchema(): Promise<void> {
  const c = db();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      section TEXT,
      content TEXT NOT NULL,
      embedding F32_BLOB(${EMBEDDING_DIM})
    )
  `);
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_chunks_vec ON chunks(libsql_vector_idx(embedding))`
  );
  await c.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, content='chunks', content_rowid='id')
  `);
}

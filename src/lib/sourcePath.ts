// The ingest stores the local file path it read from (see scripts/ingest.ts —
// e.g. /Users/.../zeroindexai/index.html). That local path must never surface,
// neither in the LLM prompt context (claude.ts) nor in any future client
// payload. Map it to the public origin at read time. No re-ingest needed: the
// mapping is deterministic since all current content is the zeroindex.ai site.
const PUBLIC_BASE = 'https://zeroindex.ai';

export function publicSourceUrl(localPath: string): string {
  // Already a public URL (future-proofing) — pass through unchanged.
  if (/^https?:\/\//i.test(localPath)) return localPath;
  // Known marketing-site source, or any unrecognized local path → apex.
  return PUBLIC_BASE;
}

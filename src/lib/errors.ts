// Safe error-message extraction. Handles non-Error throws (strings, plain
// objects, undefined) and avoids the `(e as Error).message` cast scattered
// across the codebase.

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    return typeof m === 'string' ? m : String(m);
  }
  return String(e);
}

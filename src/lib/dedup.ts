const inflight = new Map<string, Promise<unknown>>();

function makeKey(endpoint: string, params: unknown): string {
  return `${endpoint}:${JSON.stringify(params)}`;
}

export async function dedup<T>(endpoint: string, params: unknown, fn: () => Promise<T>): Promise<T> {
  const key = makeKey(endpoint, params);

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

// dedup only coalesces in-flight; dedupTtl adds a stale-while-revalidate window so repeat
// callers within ttlMs skip the network round-trip. Keep TTL short so updates propagate.
interface CacheEntry<T> { value: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>();

export async function dedupTtl<T>(
  endpoint: string,
  params: unknown,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = makeKey(endpoint, params);
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;
  // De-dupe concurrent calls while the first populates the cache.
  return dedup(endpoint, params, async () => {
    const value = await fn();
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  });
}

export function invalidateCache(endpoint?: string): void {
  if (!endpoint) { cache.clear(); return; }
  const prefix = `${endpoint}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

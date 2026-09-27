// Cirkle Brain AI — LRU Response Cache
//
// Caches Brain responses for identical queries to avoid redundant LLM calls.
// Uses an in-memory LRU (per-process) with a configurable max size + TTL.
//
// Cache key: hash of (tenantId + applicationId + mode + inputText)
// Cache value: the full BrainResponse + the final answer string
//
// Hits return instantly (no model call, no retrieval, no tool execution).
// Misses fall through to the normal Brain runtime.
//
// For production multi-instance, this would be backed by Redis or Turso.
// For now, in-memory LRU is sufficient for the single-process dev server +
// Vercel serverless (each instance has its own cache, which is fine for
// read-heavy workloads with similar queries).

interface CacheEntry {
  answer: string;
  response: any; // BrainResponse
  evidence?: any[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  cachedAt: number;
  hitCount: number;
}

const MAX_ENTRIES = 200;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map<string, CacheEntry>();

/** Build a cache key from the request parameters. */
export function buildCacheKey(opts: {
  tenantId: string;
  applicationId: string;
  mode?: string;
  inputText: string;
}): string {
  // Normalize: lowercase + trim + collapse whitespace
  const normalized = opts.inputText.toLowerCase().trim().replace(/\s+/g, " ");
  return `${opts.tenantId}:${opts.applicationId}:${opts.mode ?? "auto"}:${normalized}`;
}

/** Lookup a cached Brain response. Returns null on miss or expired entry. */
export function getCachedResponse(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  entry.hitCount++;
  // Move-to-end (LRU refresh) — delete + re-insert
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

/** Store a Brain response in the cache. */
export function setCachedResponse(key: string, entry: Omit<CacheEntry, "cachedAt" | "hitCount">): void {
  // Evict oldest entry if at capacity
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    ...entry,
    cachedAt: Date.now(),
    hitCount: 0,
  });
}

/** Get cache stats for observability. */
export function getCacheStats(): {
  size: number;
  maxSize: number;
  ttlMs: number;
  hits: number;
  misses: number;
} {
  let hits = 0;
  for (const entry of cache.values()) hits += entry.hitCount;
  return {
    size: cache.size,
    maxSize: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hits,
    misses: 0, // tracked externally — the cache can't know about its own misses
  };
}

/** Invalidate all entries (for testing or admin operations). */
export function clearCache(): void {
  cache.clear();
  inFlight.clear();
}

// ─── In-Flight Request Deduplication ──────────────────────────────────────
//
// If two users ask the same query simultaneously (or the same user double-
// clicks send), only ONE model call is made. The second request waits for
// the first to complete and receives the same cached result.
//
// Keyed by the same cache key as the response cache.

const inFlight = new Map<string, Promise<{ answer: string; response: any; evidence?: any[]; tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number }>>();

/**
 * Deduplicate in-flight requests. If a request with the same key is already
 * running, returns its promise. Otherwise, registers the factory and returns
 * the new promise.
 *
 * Usage:
 *   const result = await dedupeInFlight(key, async () => {
 *     const response = await runBrain(req);
 *     return { answer: response.answer, response, ... };
 *   });
 */
export function dedupeInFlight<T extends { answer: string; response: any; evidence?: any[]; tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number }>(
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    // Coalesce — both requests get the same result
    return existing as Promise<T>;
  }
  const promise = (async () => {
    try {
      return await factory();
    } finally {
      // Remove from in-flight map after completion (success or failure)
      inFlight.delete(key);
    }
  })() as Promise<T>;
  inFlight.set(key, promise as any);
  return promise;
}

/** Get in-flight request count (for observability). */
export function getInFlightCount(): number {
  return inFlight.size;
}

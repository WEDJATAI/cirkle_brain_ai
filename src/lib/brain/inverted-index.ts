// WEDJAT BRAIN — Inverted Index for fast retrieval.
//
// Problem: with 721+ knowledge items, the old approach loaded ALL items and
// computed cosine similarity one-by-one (O(n) per query, ~30s). Plus it did
// a separate DB query per item for conflict detection (N+1 problem).
//
// Solution: build an in-memory inverted index mapping term → Set<itemId>.
// For a query, tokenize it, look up matching items in the index (O(k) where
// k = query terms), and only score those items (typically 10-50 instead of
// 721+). The index is built lazily on first use and cached per process.
// Invalidated when new knowledge is ingested.

import { tokenize, buildTermVector, cosineSimilarity, deserializeVector } from "./vectors";

interface IndexedItem {
  id: string;
  text: string;          // claim + " " + content
  vector: ReturnType<typeof deserializeVector>;
  // metadata for reranking
  type: string;
  scope: string;
  sourceTitle?: string;
  trustLevel?: string;
  lastRefreshedAt?: Date;
  validFrom?: Date;
  validUntil?: Date;
  record: unknown;       // the full record (KnowledgeRecord or MemoryRecord)
}

interface InvertedIndex {
  items: Map<string, IndexedItem>;          // itemId → IndexedItem
  termToItems: Map<string, Set<string>>;    // term → Set of itemIds
  builtAt: number;
  tenantId: string;
  kind: "knowledge" | "memory";
}

// Cache: one index per (tenantId, kind) combination
const indexCache = new Map<string, InvertedIndex>();

function cacheKey(tenantId: string, kind: "knowledge" | "memory"): string {
  return `${kind}:${tenantId}`;
}

/** Check if an index is fresh (built within the last 5 minutes). */
function isFresh(index: InvertedIndex): boolean {
  return Date.now() - index.builtAt < 5 * 60 * 1000;
}

/**
 * Build (or rebuild) the inverted index for a given tenant + kind.
 * Fetches all active items from the DB, tokenizes them, and builds the
 * term→itemIds map.
 */
export async function buildIndex(opts: {
  tenantId: string;
  applicationId: string;
  kind: "knowledge" | "memory";
  userId?: string;
}): Promise<InvertedIndex> {
  const { db } = await import("@/lib/db");
  const { tenantId, applicationId, kind, userId } = opts;

  const items: IndexedItem[] = [];
  const termToItems = new Map<string, Set<string>>();

  if (kind === "knowledge") {
    const rows = await db.knowledgeItem.findMany({
      where: {
        tenantId,
        applicationId,
        status: { in: ["ACTIVE", "VALIDATED"] },
      },
      include: { source: true },
    });
    for (const k of rows) {
      const text = k.claim + " " + k.content;
      const vec = deserializeVector(k.contentVector);
      const tokens = tokenize(text);
      const id = k.id;
      const item: IndexedItem = {
        id, text, vector: vec,
        type: k.type, scope: k.scope,
        sourceTitle: k.source?.title,
        trustLevel: k.source?.trustLevel,
        lastRefreshedAt: k.lastRefreshedAt ?? undefined,
        validFrom: k.validFrom ?? undefined,
        validUntil: k.validUntil ?? undefined,
        record: k,
      };
      items.push(item);
      // Add to inverted index — each term maps to this item
      const seenTerms = new Set<string>();
      for (const t of tokens) {
        if (seenTerms.has(t)) continue; // each term counted once per item
        seenTerms.add(t);
        if (!termToItems.has(t)) termToItems.set(t, new Set());
        termToItems.get(t)!.add(id);
      }
    }
  } else {
    // memory
    const rows = await db.memoryItem.findMany({
      where: { tenantId, applicationId, status: "ACTIVE" },
    });
    for (const m of rows) {
      if (m.scope === "USER" && userId && m.userId !== userId) continue;
      const text = m.content;
      const vec = deserializeVector(m.contentVector);
      const tokens = tokenize(text);
      const id = m.id;
      const item: IndexedItem = {
        id, text, vector: vec,
        type: `${m.domain}/${m.type}`, scope: m.scope,
        lastRefreshedAt: m.updatedAt,
        validFrom: m.validFrom ?? undefined,
        validUntil: m.validUntil ?? undefined,
        record: m,
      };
      items.push(item);
      const seenTerms = new Set<string>();
      for (const t of tokens) {
        if (seenTerms.has(t)) continue;
        seenTerms.add(t);
        if (!termToItems.has(t)) termToItems.set(t, new Set());
        termToItems.get(t)!.add(id);
      }
    }
  }

  const itemsMap = new Map<string, IndexedItem>();
  for (const item of items) itemsMap.set(item.id, item);

  const index: InvertedIndex = {
    items: itemsMap,
    termToItems,
    builtAt: Date.now(),
    tenantId,
    kind,
  };
  indexCache.set(cacheKey(tenantId, kind), index);
  return index;
}

/** Get or build the index for a tenant + kind. Uses cache if fresh. */
export async function getIndex(opts: {
  tenantId: string;
  applicationId: string;
  kind: "knowledge" | "memory";
  userId?: string;
}): Promise<InvertedIndex> {
  const key = cacheKey(opts.tenantId, opts.kind);
  const cached = indexCache.get(key);
  if (cached && isFresh(cached)) return cached;
  return buildIndex(opts);
}

/** Invalidate the index for a tenant + kind (call after ingesting new items). */
export function invalidateIndex(tenantId: string, kind: "knowledge" | "memory"): void {
  indexCache.delete(cacheKey(tenantId, kind));
}

export interface IndexSearchResult {
  id: string;
  text: string;
  semanticScore: number;
  keywordScore: number;
  record: unknown;
  metadata: {
    type: string;
    scope: string;
    sourceTitle?: string;
    trustLevel?: string;
    lastRefreshedAt?: Date;
    validFrom?: Date;
    validUntil?: Date;
  };
}

/**
 * Search using SQL ILIKE pre-filtering + in-memory cosine scoring.
 * Instead of loading ALL items into memory (which causes OOM with 700+ items),
 * this approach:
 * 1. Tokenizes the query
 * 2. Uses SQL ILIKE to find items containing any query term (fast, DB-side)
 * 3. Only loads + scores those candidates (typically 20-50 instead of 721)
 */
export async function searchIndex(opts: {
  tenantId: string;
  applicationId: string;
  kind: "knowledge" | "memory";
  query: string;
  limit?: number;
  minScore?: number;
  userId?: string;
}): Promise<IndexSearchResult[]> {
  const { db } = await import("@/lib/db");
  const { tokenize, buildTermVector, cosineSimilarity, deserializeVector } = await import("./vectors");

  const queryTokens = tokenize(opts.query);
  if (queryTokens.length === 0) return [];

  // Build SQL ILIKE filter: any token must appear in claim OR content
  // Use OR with ILIKE for each significant token (DB-side filtering)
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0.01;

  let rows: any[] = [];
  if (opts.kind === "knowledge") {
    // Build OR conditions for each token
    const orConditions = queryTokens.flatMap((t) => [
      { claim: { contains: t } },
      { content: { contains: t } },
    ]);
    rows = await db.knowledgeItem.findMany({
      where: {
        tenantId: opts.tenantId,
        applicationId: opts.applicationId,
        status: { in: ["ACTIVE", "VALIDATED"] },
        OR: orConditions,
      },
      include: { source: true },
      take: 200, // safety cap
    });
  } else {
    const orConditions = queryTokens.flatMap((t) => [
      { content: { contains: t } },
    ]);
    rows = await db.memoryItem.findMany({
      where: {
        tenantId: opts.tenantId,
        applicationId: opts.applicationId,
        status: "ACTIVE",
        OR: orConditions,
      },
      take: 200,
    });
  }

  if (rows.length === 0) return [];

  // Score the candidates with cosine similarity
  const queryVec = buildTermVector(opts.query);
  const results: IndexSearchResult[] = [];

  for (const row of rows) {
    // Scope filtering for memory
    if (opts.kind === "memory") {
      if (row.scope === "USER" && opts.userId && row.userId !== opts.userId) continue;
    }

    const text = opts.kind === "knowledge" ? row.claim + " " + row.content : row.content;
    const vec = deserializeVector(row.contentVector);
    const sem = cosineSimilarity(queryVec, vec);
    if (sem < minScore) continue;

    const itemTokens = new Set(tokenize(text));
    let overlap = 0;
    for (const qt of queryTokens) if (itemTokens.has(qt)) overlap++;
    const kw = overlap / queryTokens.length;

    results.push({
      id: row.id,
      text,
      semanticScore: sem,
      keywordScore: kw,
      record: row,
      metadata: {
        type: opts.kind === "knowledge" ? row.type : `${row.domain}/${row.type}`,
        scope: row.scope,
        sourceTitle: row.source?.title,
        trustLevel: row.source?.trustLevel,
        lastRefreshedAt: row.lastRefreshedAt ?? row.updatedAt,
        validFrom: row.validFrom ?? undefined,
        validUntil: row.validUntil ?? undefined,
      },
    });
  }

  results.sort((a, b) => (0.5 * b.semanticScore + 0.5 * b.keywordScore) - (0.5 * a.semanticScore + 0.5 * a.keywordScore));
  return results.slice(0, limit);
}

/** Get index stats for debugging. */
export function getIndexStats(tenantId: string, kind: "knowledge" | "memory"): { items: number; terms: number; builtAt: Date | null } | null {
  const index = indexCache.get(cacheKey(tenantId, kind));
  if (!index) return null;
  return {
    items: index.items.size,
    terms: index.termToItems.size,
    builtAt: new Date(index.builtAt),
  };
}

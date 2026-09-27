#!/usr/bin/env tsx
/**
 * WEDJAT BRAIN — Turso Sync (Zero Cost Edge Cache)
 *
 * Syncs knowledge from Neon (canonical) to Turso (edge/local read replica).
 * Turso free tier: 500 DBs, 9GB, 1B reads/month — way more generous than
 * Neon's free tier for read-heavy workloads.
 *
 * This script:
 *   1. Reads all ACTIVE knowledge items from Neon
 *   2. Creates a Turso table if it doesn't exist
 *   3. Upserts each knowledge item into Turso
 *
 * Run: DATABASE_URL=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... tsx scripts/sync-turso.ts
 */

import { db } from "../src/lib/db";

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
  process.exit(1);
}

const TURSO_HTTP_URL = TURSO_URL.replace("libsql://", "https://") + "/v2/pipeline";

// Convert a bare JS value into Turso's typed Value enum (required by /v2/pipeline).
// See https://docs.turso.tech/sdk/http/reference
function toTursoValue(v: unknown): unknown {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { type: "integer", value: String(v) };
    // Turso expects float value as a JSON number (f64), not a string
    return { type: "float", value: v };
  }
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  // string, Date, anything else → text
  return { type: "text", value: String(v) };
}

async function tursoQuery(sql: string, args: unknown[] = []) {
  const body = {
    requests: [
      {
        type: "execute",
        stmt: { sql, args: args.map(toTursoValue) },
      },
      { type: "close" },
    ],
  };
  const resp = await fetch(TURSO_HTTP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TURSO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Turso query failed (${resp.status}): ${text}`);
  }
  const data = await resp.json() as any;
  return data.results?.[0]?.response?.result ?? null;
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Turso Sync — Neon → Turso (Edge Cache) ║");
  console.log("╚══════════════════════════════════════════╝");

  // Create table if it doesn't exist
  console.log("Creating brain_knowledge table in Turso (if not exists)...");
  await tursoQuery(`
    CREATE TABLE IF NOT EXISTS brain_knowledge (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      claim TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT,
      source_title TEXT,
      confidence REAL,
      valid_from TEXT,
      created_at TEXT NOT NULL
    )
  `);
  console.log("  ✓ Table ready.");

  // Read all ACTIVE knowledge from Neon
  console.log("Reading knowledge from Neon...");
  const items = await db.knowledgeItem.findMany({
    where: { status: "ACTIVE" },
    include: { source: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`  Found ${items.length} knowledge items in Neon.`);

  // Upsert into Turso
  let synced = 0;
  for (const item of items) {
    try {
      await tursoQuery(
        `INSERT OR REPLACE INTO brain_knowledge (id, type, claim, content, scope, source_title, confidence, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.type,
          item.claim,
          item.content,
          item.scope,
          item.source?.title ?? null,
          item.confidence,
          item.validFrom?.toISOString() ?? null,
          item.createdAt.toISOString(),
        ],
      );
      synced++;
      if (synced % 100 === 0) console.log(`  Synced ${synced}/${items.length}...`);
    } catch (e) {
      console.error(`  Failed to sync item ${item.id}:`, (e as Error).message);
    }
  }
  console.log(`  ✓ Synced ${synced}/${items.length} items to Turso.`);

  // Verify — Turso v2 pipeline returns rows as arrays of {type, value} objects
  const countResult = await tursoQuery(`SELECT COUNT(*) as count FROM brain_knowledge`);
  const rawCount = countResult?.rows?.[0]?.[0];
  const count = typeof rawCount === "object" && rawCount !== null
    ? Number((rawCount as any).value ?? 0)
    : Number(rawCount ?? 0);
  console.log(`  Turso now has ${count} knowledge items.`);
  console.log("✅ Turso sync complete. Edge/local reads now available via Turso.");

  await db.$disconnect();
}

main().catch((e) => {
  console.error("❌ Sync failed:", e);
  process.exit(1);
});

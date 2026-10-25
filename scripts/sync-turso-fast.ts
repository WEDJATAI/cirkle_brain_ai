#!/usr/bin/env tsx
/**
 * Fast Turso sync — parallel single-row inserts (concurrency-limited).
 */
import { db } from "../src/lib/db";

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
if (!TURSO_URL || !TURSO_TOKEN) { console.error("Missing Turso env"); process.exit(1); }
const TURSO_HTTP = TURSO_URL.replace("libsql://", "https://") + "/v2/pipeline";

async function tursoInsert(id: string, type: string, claim: string, content: string, scope: string, sourceTitle: string | null, confidence: number, createdAt: string) {
  const body = {
    requests: [
      { type: "execute", stmt: {
        sql: "INSERT OR REPLACE INTO brain_knowledge (id, type, claim, content, scope, source_title, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          { type: "text", value: id },
          { type: "text", value: type },
          { type: "text", value: claim },
          { type: "text", value: content },
          { type: "text", value: scope },
          sourceTitle ? { type: "text", value: sourceTitle } : { type: "null" },
          { type: "float", value: confidence },
          { type: "text", value: createdAt },
        ],
      }},
      { type: "close" },
    ],
  };
  const resp = await fetch(TURSO_HTTP, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Turso ${resp.status}: ${await resp.text()}`);
}

async function main() {
  console.log("Creating table...");
  await fetch(TURSO_HTTP, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "CREATE TABLE IF NOT EXISTS brain_knowledge (id TEXT PRIMARY KEY, type TEXT, claim TEXT, content TEXT, scope TEXT, source_title TEXT, confidence REAL, created_at TEXT)" }}, { type: "close" }] }),
  });

  console.log("Reading from Neon...");
  const items = await db.knowledgeItem.findMany({ where: { status: "ACTIVE" }, include: { source: true } });
  console.log(`Found ${items.length} items. Syncing (parallel, 20 at a time)...`);

  const CONCURRENCY = 20;
  let done = 0;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (item) => {
      await tursoInsert(item.id, item.type, item.claim, item.content, item.scope, item.source?.title ?? null, item.confidence, item.createdAt.toISOString());
      done++;
    }));
    if (done % 100 === 0 || done === items.length) console.log(`  ${done}/${items.length}`);
  }
  console.log(`✅ Synced ${done} items to Turso.`);
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

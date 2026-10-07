// Cirkle Brain AI — Extended Knowledge Download + Ingestion (Round 2)
//
// Downloads + ingests databases NOT previously downloaded:
// 1. World currencies (ISO 4217) — from Wikipedia
// 2. Trade agreements (WTO, FTAs, bilateral) — from Wikipedia
// 3. Container terminals — from Wikipedia
// 4. Airport frequencies (30,385 rows from OurAirports) — from CSV
// 5. Fresh AIS vessel data (962 vessels) — from collected JSON

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import * as csv from "csv-parse/sync";

const DATA_DIR = join(process.cwd(), "data", "logistics");

function strip(html: string) { return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }
function chunk(text: string, max = 500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = []; let cur = "";
  for (const s of text.match(/[^.!?]+[.!?]?\s*/g) ?? [text]) {
    if ((cur + s).length > max) { if (cur) chunks.push(cur.trim()); cur = s; } else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(c => c.length > 20);
}

async function ensureSource(tenantId: string, title: string, author: string, classification = "PUBLIC") {
  let s = await db.knowledgeSource.findFirst({ where: { tenantId, title } });
  if (!s) {
    s = await db.knowledgeSource.create({ data: { tenantId, sourceType: "web", title, author, trustLevel: "VERIFIED", verificationStatus: "VERIFIED", dataClassification: classification } });
  }
  return s;
}

async function ingestItems(tenantId: string, applicationId: string, sourceId: string, topic: string, items: Array<{claim: string; content: string}>, confidence = 0.85) {
  let ingested = 0;
  for (const item of items) {
    const existing = await db.knowledgeItem.findFirst({ where: { tenantId, sourceId, content: item.content } });
    if (existing) continue;
    await db.knowledgeItem.create({
      data: { tenantId, applicationId, sourceId, type: "FACT", scope: "APPLICATION", claim: item.claim, content: item.content,
        contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " " + topic)),
        status: "ACTIVE", confidence, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() }
    });
    ingested++;
  }
  return ingested;
}

async function fetchFromUrls(urls: string[], topic: string, sourceTitle: string): Promise<Array<{claim: string; content: string}>> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  const items: Array<{claim: string; content: string}> = [];
  for (const url of urls) {
    try {
      const result = await zai.functions.invoke("page_reader", { url }) as any;
      const text = strip(result?.data?.html ?? "").slice(0, 8000);
      if (text.length < 200) continue;
      const title = result?.data?.title ?? url;
      const chunks = chunk(text, 500);
      for (let i = 0; i < chunks.length; i++) {
        items.push({ claim: `${sourceTitle} — ${title} (part ${i+1})`, content: chunks[i] });
      }
      console.log(`    ✓ ${url.split("/").pop()?.slice(0,40)} (${text.length} chars, ${chunks.length} chunks)`);
    } catch { console.log(`    ✗ ${url.split("/").pop()?.slice(0,40)}`); }
  }
  return items;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Extended Knowledge Download + Ingestion (Round 2)         ║");
  console.log("║  Currencies + Trade Agreements + Container Terminals +     ║");
  console.log("║  Airport Frequencies + Fresh AIS Vessels                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) { console.error("no tenant/app"); process.exit(1); }

  let total = 0;

  // ─── 1. WORLD CURRENCIES (ISO 4217) ──────────────────────────────────
  console.log("━━━ 1. WORLD CURRENCIES (ISO 4217) ━━━");
  {
    const source = await ensureSource(tenant.id, "World Currencies — ISO 4217 Currency Codes", "Wikipedia (ISO 4217)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/ISO_4217",
      "https://en.wikipedia.org/wiki/List_of_circulating_currencies",
    ], "currency ISO 4217 code exchange", "World Currencies");
    const n = await ingestItems(tenant.id, application.id, source.id, "currencies ISO 4217 exchange rate", items);
    console.log(`  ✓ Ingested ${n} currency knowledge items\n`);
    total += n;
  }

  // ─── 2. TRADE AGREEMENTS (WTO, FTAs) ────────────────────────────────
  console.log("━━━ 2. TRADE AGREEMENTS (WTO, FTAs, Bilateral) ━━━");
  {
    const source = await ensureSource(tenant.id, "World Trade Agreements — WTO, FTAs, Bilateral Treaties", "Wikipedia (trade agreements)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/World_Trade_Organization",
      "https://en.wikipedia.org/wiki/Free-trade_agreement",
      "https://en.wikipedia.org/wiki/List_of_bilateral_free-trade_agreements",
      "https://en.wikipedia.org/wiki/General_Agreement_on_Tariffs_and_Trade",
      "https://en.wikipedia.org/wiki/Trans-Pacific_Partnership",
      "https://en.wikipedia.org/wiki/Regional_Comprehensive_Economic_Partnership",
      "https://en.wikipedia.org/wiki/European_Union_Single_Market",
      "https://en.wikipedia.org/wiki/African_Continental_Free_Trade_Area",
    ], "trade agreement WTO FTA bilateral tariff", "Trade Agreements");
    const n = await ingestItems(tenant.id, application.id, source.id, "trade agreements WTO FTA bilateral tariffs", items);
    console.log(`  ✓ Ingested ${n} trade agreement knowledge items\n`);
    total += n;
  }

  // ─── 3. CONTAINER TERMINALS ────────────────────────────────────────
  console.log("━━━ 3. CONTAINER TERMINALS ━━━");
  {
    const source = await ensureSource(tenant.id, "World Container Terminals — Major Container Ports and Terminals", "Wikipedia (container terminals)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Container_terminal",
      "https://en.wikipedia.org/wiki/Containerization",
      "https://en.wikipedia.org/wiki/Intermodal_freight_transport",
      "https://en.wikipedia.org/wiki/Dry_port",
      "https://en.wikipedia.org/wiki/Free_trade_zone",
    ], "container terminal port intermodal freight", "Container Terminals");
    const n = await ingestItems(tenant.id, application.id, source.id, "container terminals intermodal freight transport", items);
    console.log(`  ✓ Ingested ${n} container terminal knowledge items\n`);
    total += n;
  }

  // ─── 4. AIRPORT FREQUENCIES (30,385 rows → batched by airport) ─────
  console.log("━━━ 4. AIRPORT FREQUENCIES (OurAirports CSV) ━━━");
  {
    const filePath = join(DATA_DIR, "airport-frequencies.csv");
    if (!existsSync(filePath)) { console.log("  ✗ airport-frequencies.csv not found\n"); }
    else {
      const source = await ensureSource(tenant.id, "OurAirports — Airport Radio Frequencies (30K+ frequencies)", "OurAirports (open data, CC0)", "PUBLIC");
      const records = csv.parse(readFileSync(filePath), { columns: true, skip_empty_lines: true });
      console.log(`  Loaded ${records.length} frequency records`);

      // Group by airport_ident
      const byAirport = new Map<string, any[]>();
      for (const r of records) {
        const ident = r.airport_ident || "UNKNOWN";
        if (!byAirport.has(ident)) byAirport.set(ident, []);
        byAirport.get(ident)!.push(r);
      }
      console.log(`  Grouped into ${byAirport.size} airports`);

      // Create batched knowledge items (max 20 frequencies per item)
      const items: Array<{claim: string; content: string}> = [];
      for (const [ident, freqs] of byAirport) {
        const sample = freqs.slice(0, 10);
        const freqStr = sample.map(f => `${f.type}: ${f.frequency_mhz} MHz`).join("; ");
        items.push({
          claim: `Airport ${ident} — ${freqs.length} radio frequencies`,
          content: `Airport ${ident} radio frequencies: ${freqStr}. Total: ${freqs.length} frequencies. Types: ${[...new Set(freqs.map(f=>f.type))].join(", ")}. Source: OurAirports (CC0).`,
        });
      }

      // Batch insert (first 500 airports to avoid timeout)
      const limited = items.slice(0, 500);
      const n = await ingestItems(tenant.id, application.id, source.id, "airport frequencies radio ATIS CTAF", limited);
      console.log(`  ✓ Ingested ${n} airport frequency knowledge items (from ${limited.length} airports)\n`);
      total += n;
    }
  }

  // ─── 5. FRESH AIS VESSEL DATA (962 vessels) ─────────────────────────
  console.log("━━━ 5. FRESH AIS VESSEL DATA ━━━");
  {
    const vesselFile = "/tmp/ais-vessels-fresh.json";
    if (!existsSync(vesselFile)) { console.log("  ✗ ais-vessels-fresh.json not found (run collection first)\n"); }
    else {
      const source = await ensureSource(tenant.id, "AIS Live Vessel Tracking — Real-Time Positions", "AIS Stream API (aisstream.io)", "PUBLIC");

      // Delete old vessel items (refresh — positions change)
      const deleted = await db.knowledgeItem.deleteMany({ where: { sourceId: source.id } });
      console.log(`  Deleted old vessel items: ${deleted.count}`);

      const vessels = JSON.parse(readFileSync(vesselFile, "utf-8"));
      console.log(`  Loaded ${vessels.length} fresh vessels`);

      const data = vessels.map((v: any) => {
        const name = v.shipName || "Unknown";
        const claim = `Vessel "${name}" (MMSI ${v.mmsi}) — live position ${v.latitude.toFixed(2)},${v.longitude.toFixed(2)}`;
        const content = `LIVE AIS VESSEL TRACKING: MMSI: ${v.mmsi}${v.imo ? ", IMO: " + v.imo : ""}. Vessel Name: ${name}. Position: ${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}.${v.sog !== undefined ? " Speed: " + v.sog.toFixed(1) + " knots." : ""}${v.shipType ? " Type: " + v.shipType + "." : ""}${v.destination ? " Destination: " + v.destination + "." : ""}${v.callSign ? " CallSign: " + v.callSign + "." : ""} Data Source: AIS Stream API (aisstream.io) REAL-TIME. Messages: ${v.messageCount}.`;
        return {
          tenantId: tenant.id, applicationId: application.id, sourceId: source.id,
          type: "OBSERVATION", scope: "APPLICATION", claim, content,
          contentVector: serializeVector(buildTermVector(claim + " " + content + " vessel AIS tracking maritime shipping")),
          status: "ACTIVE", confidence: 0.95, validFrom: new Date(),
          refreshSchedule: "hourly", lastRefreshedAt: new Date(),
        };
      });

      let inserted = 0;
      for (let i = 0; i < data.length; i += 100) {
        const result = await db.knowledgeItem.createMany({ data: data.slice(i, i + 100), skipDuplicates: true });
        inserted += result.count;
      }
      console.log(`  ✓ Ingested ${inserted} fresh vessel positions\n`);
      total += inserted;
    }
  }

  // ─── 6. MARITIME LAW + CUSTOMS (extend legal knowledge) ────────────
  console.log("━━━ 6. MARITIME LAW + CUSTOMS ━━━");
  {
    const source = await ensureSource(tenant.id, "International Maritime Law + Customs Regulations", "Wikipedia (maritime law)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Admiralty_law",
      "https://en.wikipedia.org/wiki/International_Maritime_Organization",
      "https://en.wikipedia.org/wiki/Maritime_Labour_Convention",
      "https://en.wikipedia.org/wiki/SOLAS_Convention",
      "https://en.wikipedia.org/wiki/MARPOL",
      "https://en.wikipedia.org/wiki/Customs",
      "https://en.wikipedia.org/wiki/Tariff",
    ], "maritime law customs IMO SOLAS MARPOL tariff", "Maritime Law");
    const n = await ingestItems(tenant.id, application.id, source.id, "maritime law customs regulations IMO SOLAS MARPOL tariff", items);
    console.log(`  ✓ Ingested ${n} maritime law knowledge items\n`);
    total += n;
  }

  // Audit
  await db.auditEvent.create({
    data: { tenantId: tenant.id, actorType: "system", actorId: "brain.extended-knowledge-r2", action: "knowledge.extended_r2", target: "knowledge-base", reason: `Extended knowledge round 2: currencies + trade agreements + container terminals + airport frequencies + fresh AIS vessels + maritime law. Total new: ${total}`, severity: "INFO" }
  }).catch(() => {});

  const finalCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  EXTENDED KNOWLEDGE ROUND 2 COMPLETE                        ║`);
  console.log(`║  New items ingested: ${total}                                     ║`);
  console.log(`║  Total ACTIVE knowledge: ${finalCount}                             ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

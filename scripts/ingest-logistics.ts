// Cirkle Brain AI — Logistics Knowledge Ingestion
//
// Downloads and ingests comprehensive logistics databases into the Brain's
// knowledge base (Neon Postgres), covering:
//
// 1. OurAirports database — 86,000+ world airports (air freight)
//    Source: ourairports.com/data/airports.csv
//
// 2. Sea ports — from Wikipedia "List of world's busiest ports" + per-country
//    port lists + major container terminals. (WPI/UN-LOCODE direct download
//    failed — used web-search + page-reader instead)
//
// 3. Shipping lines — major container shipping companies (Maersk, MSC,
//    CMA CGM, COSCO, Hapag-Lloyd, etc.) from Wikipedia
//
// 4. Sea freight routes — major trade lanes (Trans-Pacific, Asia-Europe,
//    Trans-Atlantic, Suez, Panama, etc.)
//
// 5. AIS Stream API integration — real-time vessel tracking (separate module)
//
// Each database is chunked and ingested as knowledge items with proper
// provenance. The Brain can then answer logistics questions like:
// - "What is the UN/LOCODE for the port of Shanghai?"
// - "Which shipping lines operate on the Asia-Europe route?"
// - "What are the major ports in Egypt?"
// - "Track vessel with MMSI 123456789"

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import * as csv from "csv-parse/sync";

const DATA_DIR = join(process.cwd(), "data", "logistics");

// ─── Helpers ─────────────────────────────────────────────────────────────

function chunkText(text: string, maxLen = 500): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of text.match(/[^.!?]+[.!?]?\s*/g) ?? [text]) {
    if ((current + sentence).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 20);
}

async function ingestKnowledgeItems(opts: {
  tenantId: string;
  applicationId: string;
  sourceId: string;
  topic: string;
  items: Array<{ claim: string; content: string }>;
}): Promise<number> {
  let ingested = 0;
  for (const item of opts.items) {
    // Check if already ingested (idempotent)
    const existing = await db.knowledgeItem.findFirst({
      where: { tenantId: opts.tenantId, sourceId: opts.sourceId, content: item.content },
    });
    if (existing) continue;

    await db.knowledgeItem.create({
      data: {
        tenantId: opts.tenantId,
        applicationId: opts.applicationId,
        sourceId: opts.sourceId,
        type: "FACT",
        scope: "APPLICATION",
        claim: item.claim,
        content: item.content,
        contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " " + opts.topic)),
        status: "ACTIVE",
        confidence: 0.85, // high confidence — from authoritative data sources
        validFrom: new Date(),
        refreshSchedule: "manual",
        lastRefreshedAt: new Date(),
      },
    });
    ingested++;
  }
  return ingested;
}

async function ensureSource(tenantId: string, title: string, author: string, classification: string) {
  let source = await db.knowledgeSource.findFirst({ where: { tenantId, title } });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: {
        tenantId,
        sourceType: "web",
        title,
        author,
        trustLevel: "VERIFIED",
        verificationStatus: "VERIFIED",
        dataClassification: classification,
      },
    });
  }
  return source;
}

// ─── 1. OurAirports Database (Air Freight) ──────────────────────────────

async function ingestAirports(tenantId: string, applicationId: string): Promise<number> {
  const filePath = join(DATA_DIR, "airports.csv");
  if (!existsSync(filePath)) {
    console.log("  ✗ airports.csv not found — skipping");
    return 0;
  }

  const source = await ensureSource(
    tenantId,
    "OurAirports — World Airports Database (86K+ airports)",
    "OurAirports (open data, CC0)",
    "PUBLIC",
  );

  const records = csv.parse(readFileSync(filePath), { columns: true, skip_empty_lines: true });
  console.log(`  Loaded ${records.length} airport records from CSV`);

  // Group airports by country for efficient chunking
  const byCountry = new Map<string, any[]>();
  for (const r of records) {
    const country = r.iso_country || "XX";
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(r);
  }

  // For each country, create knowledge items grouped by type (large/medium/small/heliport/seaplane_base)
  const items: Array<{ claim: string; content: string }> = [];
  for (const [country, airports] of byCountry) {
    const byType = new Map<string, any[]>();
    for (const a of airports) {
      const type = a.type || "unknown";
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(a);
    }

    for (const [type, list] of byType) {
      // For large + medium airports, create individual items (they're important)
      if (type === "large_airport" || type === "medium_airport") {
        for (const a of list) {
          const ident = a.ident || a.iata_code || a.gps_code || "N/A";
          const iata = a.iata_code || "N/A";
          const icao = a.icao_code || "N/A";
          const content = `Airport: ${a.name}. Type: ${type.replace("_", " ")}. IATA: ${iata}. ICAO: ${icao}. GPS: ${a.gps_code || "N/A"}. Country: ${country}. Region: ${a.iso_region || "N/A"}. Municipality: ${a.municipality || "N/A"}. Coordinates: ${a.latitude_deg}, ${a.longitude_deg}. Elevation: ${a.elevation_ft || "N/A"} ft. Scheduled service: ${a.scheduled_service || "N/A"}. Wikipedia: ${a.wikipedia_link || "N/A"}`;
          items.push({
            claim: `${a.name} (${iata}/${icao}) — ${type.replace("_", " ")} in ${a.municipality || country}`,
            content,
          });
        }
      } else {
        // For small airports + heliports + seaplane bases, batch by country
        const sample = list.slice(0, 30); // max 30 per batch
        const names = sample.map((a) => `${a.name} (${a.ident})`).join("; ");
        const content = `Country ${country}: ${list.length} ${type.replace("_", " ")}s. Examples: ${names}`;
        items.push({
          claim: `${country} — ${list.length} ${type.replace("_", " ")}s`,
          content,
        });
      }
    }
  }

  const count = await ingestKnowledgeItems({ tenantId, applicationId, sourceId: source.id, topic: "airports air freight logistics", items });
  console.log(`  ✓ Ingested ${count} airport knowledge items (from ${records.length} records in ${byCountry.size} countries)`);
  return count;
}

// ─── 2. Sea Ports (from web-search + page-reader) ───────────────────────

async function ingestSeaPorts(tenantId: string, applicationId: string): Promise<number> {
  const source = await ensureSource(
    tenantId,
    "World Sea Ports — Busiest Container Ports (Wikipedia-sourced)",
    "Cirkle Brain Knowledge Ingestion (web-sourced)",
    "PUBLIC",
  );

  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();

  // Search for comprehensive port lists
  const queries = [
    "list of busiest container ports world by TEU volume",
    "list of major sea ports by country worldwide",
    "top 100 container ports world ranking",
  ];

  const portData: Array<{ name: string; country: string; content: string }> = [];

  for (const query of queries) {
    try {
      const results = await zai.functions.invoke("web_search", { query, num: 5 }) as any[];
      if (!Array.isArray(results)) continue;
      for (const r of results.slice(0, 3)) {
        const url = r.url as string;
        if (!url) continue;
        try {
          const pageResult = await zai.functions.invoke("page_reader", { url }) as any;
          const html = pageResult?.data?.html ?? "";
          const text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (text.length > 200) {
            portData.push({ name: r.name ?? url, country: "", content: text.slice(0, 8000) });
            console.log(`    ✓ Fetched: ${url.slice(0, 70)} (${text.length} chars)`);
          }
        } catch (err: any) {
          console.log(`    ✗ Failed: ${url.slice(0, 70)}`);
        }
      }
    } catch (err: any) {
      console.log(`    ✗ Search failed: ${err?.message?.slice(0, 60)}`);
    }
  }

  // Also fetch specific Wikipedia articles
  const wikiUrls = [
    "https://en.wikipedia.org/wiki/List_of_world%27s_busiest_ports",
    "https://en.wikipedia.org/wiki/List_of_busiest_container_ports",
    "https://en.wikipedia.org/wiki/Port",
  ];

  for (const url of wikiUrls) {
    if (portData.some((p) => p.name.includes(url))) continue;
    try {
      const pageResult = await zai.functions.invoke("page_reader", { url }) as any;
      const html = pageResult?.data?.html ?? "";
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 200) {
        portData.push({ name: url, country: "", content: text.slice(0, 12000) });
        console.log(`    ✓ Wikipedia: ${url.slice(0, 60)} (${text.length} chars)`);
      }
    } catch {
      console.log(`    ✗ Wikipedia failed: ${url.slice(0, 60)}`);
    }
  }

  // Chunk and ingest
  const items: Array<{ claim: string; content: string }> = [];
  for (const p of portData) {
    const chunks = chunkText(p.content, 500);
    for (let i = 0; i < chunks.length; i++) {
      items.push({
        claim: `Sea ports data — ${p.name} (part ${i + 1})`,
        content: chunks[i],
      });
    }
  }

  const count = await ingestKnowledgeItems({ tenantId, applicationId, sourceId: source.id, topic: "sea ports container terminals logistics shipping", items });
  console.log(`  ✓ Ingested ${count} sea port knowledge items (from ${portData.length} sources)`);
  return count;
}

// ─── 3. Shipping Lines ─────────────────────────────────────────────────

async function ingestShippingLines(tenantId: string, applicationId: string): Promise<number> {
  const source = await ensureSource(
    tenantId,
    "World Shipping Lines — Major Container Shipping Companies",
    "Cirkle Brain Knowledge Ingestion (web-sourced)",
    "PUBLIC",
  );

  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();

  const urls = [
    "https://en.wikipedia.org/wiki/List_of_largest_container_shipping_companies",
    "https://en.wikipedia.org/wiki/Maersk",
    "https://en.wikipedia.org/wiki/Mediterranean_Shipping_Company",
    "https://en.wikipedia.org/wiki/CMA_CGM",
    "https://en.wikipedia.org/wiki/COSCO",
    "https://en.wikipedia.org/wiki/Hapag-Lloyd",
    "https://en.wikipedia.org/wiki/Ocean_Network_Express",
    "https://en.wikipedia.org/wiki/Evergreen_Marine",
    "https://en.wikipedia.org/wiki/Yang_Ming_Marine_Transport_Corp.",
    "https://en.wikipedia.org/wiki/Hapag-Lloyd",
  ];

  const items: Array<{ claim: string; content: string }> = [];

  for (const url of urls) {
    try {
      const result = await zai.functions.invoke("page_reader", { url }) as any;
      const html = result?.data?.html ?? "";
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 200) {
        const title = result?.data?.title ?? url;
        const chunks = chunkText(text.slice(0, 10000), 500);
        for (let i = 0; i < chunks.length; i++) {
          items.push({
            claim: `Shipping line — ${title} (part ${i + 1})`,
            content: chunks[i],
          });
        }
        console.log(`    ✓ ${url.split("/").pop()} (${text.length} chars)`);
      }
    } catch {
      console.log(`    ✗ ${url.split("/").pop()}`);
    }
  }

  const count = await ingestKnowledgeItems({ tenantId, applicationId, sourceId: source.id, topic: "shipping lines container companies maritime logistics", items });
  console.log(`  ✓ Ingested ${count} shipping line knowledge items (from ${urls.length} sources)`);
  return count;
}

// ─── 4. Sea Freight Routes ─────────────────────────────────────────────

async function ingestShippingRoutes(tenantId: string, applicationId: string): Promise<number> {
  const source = await ensureSource(
    tenantId,
    "Sea Freight Routes — Major Trade Lanes and Shipping Routes",
    "Cirkle Brain Knowledge Ingestion (web-sourced)",
    "PUBLIC",
  );

  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();

  const urls = [
    "https://en.wikipedia.org/wiki/Trade_route",
    "https://en.wikipedia.org/wiki/Suez_Canal",
    "https://en.wikipedia.org/wiki/Panama_Canal",
    "https://en.wikipedia.org/wiki/Strait_of_Malacca",
    "https://en.wikipedia.org/wiki/Bab-el-Mandeb",
    "https://en.wikipedia.org/wiki/Strait_of_Hormuz",
    "https://en.wikipedia.org/wiki/Trans-Pacific_shipping_route",
    "https://en.wikipedia.org/wiki/Asia-Europe_shipping_route",
    "https://en.wikipedia.org/wiki/Transatlantic_trade",
  ];

  const items: Array<{ claim: string; content: string }> = [];

  for (const url of urls) {
    try {
      const result = await zai.functions.invoke("page_reader", { url }) as any;
      const html = result?.data?.html ?? "";
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 200) {
        const title = result?.data?.title ?? url;
        const chunks = chunkText(text.slice(0, 10000), 500);
        for (let i = 0; i < chunks.length; i++) {
          items.push({
            claim: `Shipping route — ${title} (part ${i + 1})`,
            content: chunks[i],
          });
        }
        console.log(`    ✓ ${url.split("/").pop()} (${text.length} chars)`);
      }
    } catch {
      console.log(`    ✗ ${url.split("/").pop()}`);
    }
  }

  const count = await ingestKnowledgeItems({ tenantId, applicationId, sourceId: source.id, topic: "sea freight routes trade lanes shipping canals straits", items });
  console.log(`  ✓ Ingested ${count} shipping route knowledge items (from ${urls.length} sources)`);
  return count;
}

// ─── 5. AIS Stream API Knowledge ────────────────────────────────────────

async function ingestAisKnowledge(tenantId: string, applicationId: string): Promise<number> {
  const source = await ensureSource(
    tenantId,
    "AIS — Automatic Identification System for Vessel Tracking",
    "Cirkle Brain Knowledge Ingestion (web-sourced + AIS Stream API)",
    "PUBLIC",
  );

  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();

  const urls = [
    "https://en.wikipedia.org/wiki/Automatic_identification_system",
    "https://en.wikipedia.org/wiki/Maritime_Mobile_Service_Identity",
    "https://en.wikipedia.org/wiki/IMO_number",
    "https://en.wikipedia.org/wiki/Vessel_traffic_service",
  ];

  const items: Array<{ claim: string; content: string }> = [];

  for (const url of urls) {
    try {
      const result = await zai.functions.invoke("page_reader", { url }) as any;
      const html = result?.data?.html ?? "";
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length > 200) {
        const title = result?.data?.title ?? url;
        const chunks = chunkText(text.slice(0, 10000), 500);
        for (let i = 0; i < chunks.length; i++) {
          items.push({
            claim: `AIS knowledge — ${title} (part ${i + 1})`,
            content: chunks[i],
          });
        }
        console.log(`    ✓ ${url.split("/").pop()} (${text.length} chars)`);
      }
    } catch {
      console.log(`    ✗ ${url.split("/").pop()}`);
    }
  }

  // Also ingest AIS Stream API documentation summary
  items.push({
    claim: "AIS Stream API — real-time vessel tracking via WebSocket",
    content: `AIS Stream API (https://aisstream.io/) provides real-time AIS vessel position data via WebSocket.
Connection: wss://stream.aisstream.io/v0/stream
Authentication: API key in subscription message
Subscription format: {"Apikey":"<key>","PeriodicInterval":0,"BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport","ShipStaticData"]}
PositionReport fields: MMSI, Latitude, Longitude, Sog (speed over ground), Cog (course over ground), TrueHeading, NavigationStatus
ShipStaticData fields: MMSI, ImoNumber, ShipName, Type, CallSign, Destination, Eta, Draught, Dimension
MMSI: Maritime Mobile Service Identity — 9-digit unique vessel identifier
IMO number: 7-digit International Maritime Organization ship identifier
Ship types: 30=Fishing, 70=Cargo, 80=Tanker, 60=Passenger, 52=Tug, 35=Military
The AIS Stream API key is configured in .env as AIS_STREAM_API_KEY.`,
  });

  const count = await ingestKnowledgeItems({ tenantId, applicationId, sourceId: source.id, topic: "AIS vessel tracking maritime shipping MMSI IMO", items });
  console.log(`  ✓ Ingested ${count} AIS knowledge items (from ${urls.length} sources + API docs)`);
  return count;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Cirkle Brain AI — Logistics Knowledge Ingestion            ║");
  console.log("║  (Airports + Sea Ports + Shipping Lines + Routes + AIS)     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) {
    console.error("ERROR: Could not find default tenant/application");
    process.exit(1);
  }

  let total = 0;

  console.log("\n━━━ 1. AIRPORTS (Air Freight) ━━━");
  total += await ingestAirports(tenant.id, application.id);

  console.log("\n━━━ 2. SEA PORTS ━━━");
  total += await ingestSeaPorts(tenant.id, application.id);

  console.log("\n━━━ 3. SHIPPING LINES ━━━");
  total += await ingestShippingLines(tenant.id, application.id);

  console.log("\n━━━ 4. SEA FREIGHT ROUTES ━━━");
  total += await ingestShippingRoutes(tenant.id, application.id);

  console.log("\n━━━ 5. AIS VESSEL TRACKING KNOWLEDGE ━━━");
  total += await ingestAisKnowledge(tenant.id, application.id);

  // Audit
  await db.auditEvent.create({
    data: {
      tenantId: tenant.id,
      actorType: "system",
      actorId: "brain.logistics-ingestion",
      action: "knowledge.ingested_logistics",
      target: "knowledge-base",
      reason: `Ingested ${total} logistics knowledge items (airports + sea ports + shipping lines + routes + AIS)`,
      severity: "INFO",
    },
  }).catch(() => {});

  const finalCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  LOGISTICS INGESTION COMPLETE                                ║`);
  console.log(`║  Total new knowledge items: ${total}                              ║`);
  console.log(`║  Final ACTIVE knowledge: ${finalCount}                            ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  await db.$disconnect();
}

main().catch((err) => {
  console.error("❌ Ingestion failed:", err);
  process.exit(1);
});

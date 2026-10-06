// Cirkle Brain AI — EXPANDED Self-Training (ALL databases)
//
// Runs adversarial self-training across ALL 22 knowledge sources.
// 50+ challenge questions covering every domain the Brain has learned.
// Finds gaps + auto-fetches missing knowledge via web-search + page-reader.

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";

interface Challenge {
  q: string;
  domain: string;
  keywords: string[];
  search: string;
}

const CHALLENGES: Challenge[] = [
  // ─── Airports (1,418 items — extend with specific IATA/ICAO lookups) ───
  { q: "What is the IATA code for Cairo International Airport?", domain: "airports", keywords: ["CAI", "Cairo", "HECA"], search: "Cairo International Airport IATA code CAI ICAO HECA" },
  { q: "What is the IATA code for Dubai International Airport?", domain: "airports", keywords: ["DXB", "Dubai", "OMDB"], search: "Dubai International Airport IATA DXB ICAO OMDB" },
  { q: "What is the IATA code for Singapore Changi Airport?", domain: "airports", keywords: ["SIN", "Changi", "WSSS"], search: "Singapore Changi Airport IATA SIN ICAO WSSS" },
  { q: "What is the IATA code for Hong Kong International Airport?", domain: "airports", keywords: ["HKG", "Hong Kong", "VHHH"], search: "Hong Kong International Airport IATA HKG ICAO VHHH" },
  { q: "What is the IATA code for Frankfurt Airport?", domain: "airports", keywords: ["FRA", "Frankfurt", "EDDF"], search: "Frankfurt Airport IATA FRA ICAO EDDF" },

  // ─── Sea Ports (129 items — extend with UN/LOCODE + port details) ─────
  { q: "What is the UN/LOCODE for Port of Shanghai?", domain: "sea-ports", keywords: ["CNSHA", "Shanghai"], search: "UN LOCODE Port of Shanghai CNSHA" },
  { q: "What is the UN/LOCODE for Port of Singapore?", domain: "sea-ports", keywords: ["SGSIN", "Singapore"], search: "UN LOCODE Port of Singapore SGSIN" },
  { q: "What is the UN/LOCODE for Port of Rotterdam?", domain: "sea-ports", keywords: ["NLRTM", "Rotterdam"], search: "UN LOCODE Port of Rotterdam NLRTM" },
  { q: "What is the UN/LOCODE for Port of Los Angeles?", domain: "sea-ports", keywords: ["USLAX", "Los Angeles"], search: "UN LOCODE Port of Los Angeles USLAX" },
  { q: "What is the UN/LOCODE for Port of Hamburg?", domain: "sea-ports", keywords: ["DEHAM", "Hamburg"], search: "UN LOCODE Port of Hamburg DEHAM" },
  { q: "What is the UN/LOCODE for Port of Antwerp?", domain: "sea-ports", keywords: ["BEANR", "Antwerp"], search: "UN LOCODE Port of Antwerp BEANR" },
  { q: "What is the UN/LOCODE for Port of Busan?", domain: "sea-ports", keywords: ["KRPUS", "Busan"], search: "UN LOCODE Port of Busan KRPUS" },
  { q: "What is the UN/LOCODE for Port of Ningbo-Zhoushan?", domain: "sea-ports", keywords: ["CNNGB", "Ningbo"], search: "UN LOCODE Port of Ningbo Zhoushan CNNGB" },

  // ─── Shipping Lines (91 items — extend with fleet + route details) ────
  { q: "What is the TEU capacity of Maersk fleet?", domain: "shipping-lines", keywords: ["Maersk", "TEU", "fleet"], search: "Maersk fleet TEU capacity 2024" },
  { q: "What is the TEU capacity of MSC fleet?", domain: "shipping-lines", keywords: ["MSC", "TEU", "fleet"], search: "MSC Mediterranean Shipping Company fleet TEU 2024" },
  { q: "What is the largest container ship in the world?", domain: "shipping-lines", keywords: ["MSC", "Irina", "largest", "TEU"], search: "largest container ship world 2024 MSC Irina TEU" },
  { q: "What is the CMA CGM fleet size?", domain: "shipping-lines", keywords: ["CMA CGM", "fleet", "TEU"], search: "CMA CGM fleet size TEU capacity 2024" },
  { q: "What routes does Hapag-Lloyd operate?", domain: "shipping-lines", keywords: ["Hapag-Lloyd", "routes", "services"], search: "Hapag-Lloyd shipping routes services 2024" },

  // ─── Sea Freight Routes (58 items — extend with distances + transit) ──
  { q: "What is the distance from Shanghai to Rotterdam via Suez Canal?", domain: "trade-routes", keywords: ["Shanghai", "Rotterdam", "Suez", "nautical", "miles"], search: "distance Shanghai to Rotterdam via Suez Canal nautical miles" },
  { q: "What is the transit time through the Suez Canal?", domain: "trade-routes", keywords: ["Suez", "transit", "hours", "time"], search: "Suez Canal transit time hours average" },
  { q: "What is the distance from Shanghai to Los Angeles?", domain: "trade-routes", keywords: ["Shanghai", "Los Angeles", "Trans-Pacific", "nautical"], search: "distance Shanghai to Los Angeles Trans-Pacific nautical miles" },
  { q: "What is the Cape of Good Hope route distance?", domain: "trade-routes", keywords: ["Cape", "Good Hope", "distance", "nautical"], search: "Cape of Good Hope route distance nautical miles Asia Europe" },
  { q: "How many vessels transit the Panama Canal daily?", domain: "trade-routes", keywords: ["Panama", "Canal", "vessels", "daily", "transit"], search: "Panama Canal daily vessel transits average" },

  // ─── HS Codes Vegetables (58 — extend with specific codes) ───────────
  { q: "What is the HS code for fresh onions?", domain: "hs-codes-vegetables", keywords: ["0703", "onion"], search: "HS code fresh onions 0703 WCO" },
  { q: "What is the HS code for fresh cabbage?", domain: "hs-codes-vegetables", keywords: ["0704", "cabbage"], search: "HS code fresh cabbage 0704 WCO" },
  { q: "What is the HS code for fresh carrots?", domain: "hs-codes-vegetables", keywords: ["0706", "carrot"], search: "HS code fresh carrots 0706 WCO" },
  { q: "What is the HS code for fresh cucumbers?", domain: "hs-codes-vegetables", keywords: ["0707", "cucumber"], search: "HS code fresh cucumbers 0707 WCO" },

  // ─── HS Codes Fruits (58 — extend) ──────────────────────────────────
  { q: "What is the HS code for fresh oranges?", domain: "hs-codes-fruits", keywords: ["0805", "orange", "citrus"], search: "HS code fresh oranges 0805 WCO" },
  { q: "What is the HS code for fresh grapes?", domain: "hs-codes-fruits", keywords: ["0806", "grape"], search: "HS code fresh grapes 0806 WCO" },
  { q: "What is the HS code for fresh bananas?", domain: "hs-codes-fruits", keywords: ["0803", "banana"], search: "HS code fresh bananas 0803 WCO" },
  { q: "What is the HS code for fresh pineapples?", domain: "hs-codes-fruits", keywords: ["0804", "pineapple"], search: "HS code fresh pineapples 0804 WCO" },

  // ─── HS Codes Oils (58 — extend) ───────────────────────────────────
  { q: "What is the HS code for olive oil?", domain: "hs-codes-oils", keywords: ["1509", "olive"], search: "HS code olive oil 1509 WCO" },
  { q: "What is the HS code for palm oil?", domain: "hs-codes-oils", keywords: ["1511", "palm"], search: "HS code palm oil 1511 WCO" },
  { q: "What is the HS code for sunflower oil?", domain: "hs-codes-oils", keywords: ["1512", "sunflower"], search: "HS code sunflower oil 1512 WCO" },
  { q: "What is the HS code for soybean oil?", domain: "hs-codes-oils", keywords: ["1507", "soybean"], search: "HS code soybean oil 1507 WCO" },

  // ─── Egyptian Constitution (578 items — extend with specific articles) ─
  { q: "What does Article 2 of the Egyptian Constitution say about Islam?", domain: "egyptian-constitution", keywords: ["Article 2", "Islam", "Sharia"], search: "Egyptian Constitution 2014 Article 2 Islam Sharia principle" },
  { q: "What does Article 5 of the Egyptian Constitution say about political parties?", domain: "egyptian-constitution", keywords: ["Article 5", "political", "party"], search: "Egyptian Constitution 2014 Article 5 political parties" },
  { q: "What does Article 8 of the Egyptian Constitution say about equality?", domain: "egyptian-constitution", keywords: ["Article 8", "equality", "discrimination"], search: "Egyptian Constitution 2014 Article 8 equality" },
  { q: "What does Article 15 of the Egyptian Constitution say about agriculture?", domain: "egyptian-constitution", keywords: ["Article 15", "agriculture"], search: "Egyptian Constitution 2014 Article 15 agriculture" },
  { q: "What does Article 25 of the Egyptian Constitution say about the political system?", domain: "egyptian-constitution", keywords: ["Article 25", "political", "system"], search: "Egyptian Constitution 2014 Article 25 political system" },
  { q: "What does Article 46 of the Egyptian Constitution say about the environment?", domain: "egyptian-constitution", keywords: ["Article 46", "environment"], search: "Egyptian Constitution 2014 Article 46 environment" },
  { q: "What does Article 50 of the Egyptian Constitution say about the Suez Canal?", domain: "egyptian-constitution", keywords: ["Article 50", "Suez", "Canal"], search: "Egyptian Constitution 2014 Article 50 Suez Canal" },

  // ─── Egyptian Personal Status Law (6 items — MOST NEEDS EXTENSION!) ──
  { q: "What are the marriage requirements under Egyptian personal status law?", domain: "egyptian-family-law", keywords: ["marriage", "requirements", "Egypt", "contract"], search: "Egyptian personal status law marriage requirements contract" },
  { q: "What are the types of divorce under Egyptian law?", domain: "egyptian-family-law", keywords: ["divorce", "Talaq", "Khul", "Egypt"], search: "Egyptian personal status law types of divorce Talaq Khul" },
  { q: "What is the Mahr (dowry) under Egyptian personal status law?", domain: "egyptian-family-law", keywords: ["Mahr", "dowry", "Egypt"], search: "Egyptian personal status law Mahr dowry" },
  { q: "What are the child custody rules under Egyptian personal status law?", domain: "egyptian-family-law", keywords: ["custody", "child", "Egypt", "Hadana"], search: "Egyptian personal status law child custody Hadana" },
  { q: "What is the legal waiting period (Iddah) under Egyptian law?", domain: "egyptian-family-law", keywords: ["Iddah", "waiting", "period", "Egypt"], search: "Egyptian personal status law Iddah waiting period" },
  { q: "What are the financial obligations of a husband under Egyptian family law?", domain: "egyptian-family-law", keywords: ["Nafaqah", "financial", "husband", "maintenance"], search: "Egyptian personal status law husband financial obligations Nafaqah" },

  // ─── AIS Vessel Tracking (158 items — extend with technical details) ─
  { q: "What is the difference between AIS Class A and Class B transponders?", domain: "ais-vessel-tracking", keywords: ["Class A", "Class B", "transponder", "difference"], search: "AIS Class A vs Class B transponder difference technical" },
  { q: "What is the AIS broadcast interval for a moving vessel?", domain: "ais-vessel-tracking", keywords: ["AIS", "broadcast", "interval", "seconds"], search: "AIS broadcast interval moving vessel seconds Class A" },
  { q: "What are the AIS message types?", domain: "ais-vessel-tracking", keywords: ["message", "type", "1", "2", "3", "4", "5"], search: "AIS message types 1 2 3 4 5 18 24 27" },
  { q: "What is the range of AIS signals?", domain: "ais-vessel-tracking", keywords: ["range", "AIS", "VHF", "nautical"], search: "AIS signal range VHF nautical miles" },

  // ─── General Knowledge (848 items — extend with new topics) ────────
  { q: "What is the Inngest function registry?", domain: "general", keywords: ["Inngest", "function", "registry"], search: "Inngest function registry background jobs" },
  { q: "What is the Prisma ORM?", domain: "general", keywords: ["Prisma", "ORM", "database"], search: "Prisma ORM database TypeScript" },
  { q: "What is the Next.js App Router?", domain: "general", keywords: ["Next.js", "App", "Router"], search: "Next.js App Router 16 server components" },

  // ─── Cross-Domain Synthesis (6 items — extend with new links) ───────
  { q: "How does the Brent Crude Oil price affect shipping freight rates?", domain: "cross-domain", keywords: ["Brent", "bunker", "freight", "fuel"], search: "Brent crude oil price effect on shipping freight rates bunker fuel" },
  { q: "How does the Suez Canal closure affect global supply chains?", domain: "cross-domain", keywords: ["Suez", "closure", "supply", "chain"], search: "Suez Canal closure effect global supply chain 2021 Ever Given" },
  { q: "How do HS codes affect Egyptian customs duties?", domain: "cross-domain", keywords: ["HS", "customs", "duty", "Egypt"], search: "HS codes Egyptian customs duties tariff" },
  { q: "How does AIS vessel tracking improve port safety?", domain: "cross-domain", keywords: ["AIS", "port", "safety", "traffic"], search: "AIS vessel tracking port safety traffic management" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

async function checkGap(q: string, keywords: string[]): Promise<{ hasGap: boolean; evidence: number; matched: number }> {
  const items = await db.knowledgeItem.findMany({
    where: { status: "ACTIVE", OR: keywords.map(kw => ({ content: { contains: kw } })) },
    take: 5,
    select: { content: true },
  });
  if (items.length === 0) return { hasGap: true, evidence: 0, matched: 0 };
  let matched = 0;
  for (const kw of keywords) {
    for (const item of items) {
      if (item.content.toLowerCase().includes(kw.toLowerCase())) { matched++; break; }
    }
  }
  return { hasGap: matched < Math.ceil(keywords.length / 2), evidence: items.length, matched };
}

async function fetchAndIngest(opts: { tenantId: string; applicationId: string; sourceId: string; search: string; domain: string; question: string }): Promise<number> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  let ingested = 0;
  try {
    const results = await zai.functions.invoke("web_search", { query: opts.search, num: 3 }) as any[];
    if (!Array.isArray(results) || results.length === 0) return 0;
    for (const r of results.slice(0, 2)) {
      const url = r.url as string;
      if (!url) continue;
      try {
        const pr = await zai.functions.invoke("page_reader", { url }) as any;
        const text = (pr?.data?.html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
        if (text.length < 100) continue;
        const chunks: string[] = [];
        let cur = "";
        for (const s of text.match(/[^.!?]+[.!?]?\s*/g) ?? [text]) {
          if ((cur + s).length > 500) { if (cur) chunks.push(cur.trim()); cur = s; } else cur += s;
        }
        if (cur.trim()) chunks.push(cur.trim());
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk.length < 30) continue;
          const existing = await db.knowledgeItem.findFirst({ where: { tenantId: opts.tenantId, sourceId: opts.sourceId, content: chunk } });
          if (existing) continue;
          await db.knowledgeItem.create({
            data: {
              tenantId: opts.tenantId, applicationId: opts.applicationId, sourceId: opts.sourceId,
              type: "FACT", scope: "APPLICATION",
              claim: `${opts.domain} — auto-trained (Q: "${opts.question.slice(0, 50)}") part ${i + 1}`,
              content: chunk,
              contentVector: serializeVector(buildTermVector(chunk + " " + opts.domain + " " + opts.question)),
              status: "ACTIVE", confidence: 0.75,
              validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date(),
            },
          });
          ingested++;
        }
        console.log(`      ✓ ${url.slice(0, 60)} (${chunks.length} chunks)`);
        break;
      } catch { /* try next */ }
    }
  } catch (err: any) {
    console.log(`      ✗ ${err?.message?.slice(0, 60) ?? "failed"}`);
  }
  return ingested;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  EXPANDED SELF-TRAINING — ALL DATABASES                     ║");
  console.log(`║  ${CHALLENGES.length} challenges across all 22 knowledge sources         ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) { console.error("no tenant/app"); process.exit(1); }

  let source = await db.knowledgeSource.findFirst({ where: { tenantId: tenant.id, title: "Expanded Self-Training — All Databases" } });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: { tenantId: tenant.id, sourceType: "web", title: "Expanded Self-Training — All Databases", author: "Cirkle Brain Expanded Self-Training", trustLevel: "SUPPORTED", verificationStatus: "UNVERIFIED", dataClassification: "PUBLIC" },
    });
  }

  const before = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log(`Starting knowledge base: ${before} items\n`);

  let gaps = 0, filled = 0, totalIngested = 0;
  const domainStats: Record<string, { gaps: number; filled: number; ingested: number }> = {};

  for (let i = 0; i < CHALLENGES.length; i++) {
    const c = CHALLENGES[i];
    const domain = c.domain;
    if (!domainStats[domain]) domainStats[domain] = { gaps: 0, filled: 0, ingested: 0 };

    console.log(`━━━ ${i + 1}/${CHALLENGES.length} [${domain}] ━━━`);
    console.log(`  Q: ${c.q}`);

    const gap = await checkGap(c.q, c.keywords);
    console.log(`  Retrieval: ${gap.evidence} items, ${gap.matched}/${c.keywords.length} keywords matched`);

    if (gap.hasGap) {
      gaps++;
      domainStats[domain].gaps++;
      console.log(`  ⚠️  GAP — auto-fetching...`);
      const ingested = await fetchAndIngest({ tenantId: tenant.id, applicationId: application.id, sourceId: source.id, search: c.search, domain, question: c.q });
      if (ingested > 0) {
        filled++;
        domainStats[domain].filled++;
        totalIngested += ingested;
        domainStats[domain].ingested += ingested;
        console.log(`  ✓ FILLED — ${ingested} items ingested`);
      } else {
        console.log(`  ✗ Could not fill`);
      }
    } else {
      console.log(`  ✓ Already knows this`);
    }
    console.log("");
  }

  // Audit
  await db.auditEvent.create({
    data: { tenantId: tenant.id, actorType: "system", actorId: "brain.expanded-self-training", action: "knowledge.expanded_self_training_all", target: source.id, reason: `Expanded training: ${CHALLENGES.length} challenges across all databases, ${gaps} gaps found, ${filled} filled, ${totalIngested} items ingested`, severity: "INFO" },
  }).catch(() => {});

  const after = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  EXPANDED SELF-TRAINING COMPLETE                            ║`);
  console.log(`║  Challenges: ${CHALLENGES.length}                                             ║`);
  console.log(`║  Gaps found: ${gaps}                                                 ║`);
  console.log(`║  Gaps filled: ${filled}                                                ║`);
  console.log(`║  Items ingested: ${totalIngested}                                        ║`);
  console.log(`║  Knowledge: ${before} → ${after} (+${after - before})                                  ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log("\nDomain breakdown:");
  for (const [domain, stats] of Object.entries(domainStats)) {
    if (stats.gaps > 0) {
      console.log(`  ${domain}: ${stats.gaps} gaps, ${stats.filled} filled, +${stats.ingested} items`);
    }
  }

  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

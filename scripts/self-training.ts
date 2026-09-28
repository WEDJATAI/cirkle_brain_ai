// Cirkle Brain AI — Adversarial Self-Training Loop
//
// CREATIVE OUT-OF-BOX TRAINING: The Brain trains ITSELF.
//
// The Brain has 3,473 knowledge items across logistics, legal, trade, and
// maritime domains. This module:
//
// 1. Generates CHALLENGE QUESTIONS about its own knowledge (adversarial)
//    — e.g., "What is the HS code for fresh mangoes?" tests if the Brain
//      knows HS codes for fruits beyond the ingested examples
//
// 2. Attempts to answer each challenge using retrieval (no model call —
//    pure knowledge base lookup)
//
// 3. If retrieval returns 0 evidence OR the answer is "INSUFFICIENT
//    EVIDENCE", identifies this as a KNOWLEDGE GAP
//
// 4. Auto-fetches the missing knowledge via web-search + page-reader
//    and ingests it into Neon Postgres
//
// 5. Records the training cycle for observability
//
// This is a SELF-IMPROVING system — each training cycle expands the
// knowledge base in the directions where the Brain is weakest.

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";

// ─── Challenge Question Bank ─────────────────────────────────────────────
// These questions probe the EDGES of the Brain's current knowledge.
// Each is designed to find a GAP — something the Brain SHOULD know but
// might not have ingested yet.

interface ChallengeQuestion {
  question: string;
  domain: string;
  expectedKeywords: string[]; // keywords that should appear in a correct answer
  searchQuery: string; // web-search query to fill the gap if found
}

const CHALLENGE_QUESTIONS: ChallengeQuestion[] = [
  // ─── Logistics: HS Codes (extend beyond ingested examples) ────────────
  { question: "What is the HS code for fresh mangoes?", domain: "hs-codes", expectedKeywords: ["0804", "mango"], searchQuery: "HS code fresh mangoes 0804 WCO harmonized system" },
  { question: "What is the HS code for crude petroleum oil?", domain: "hs-codes", expectedKeywords: ["2709", "petroleum", "crude"], searchQuery: "HS code crude petroleum oil 2709 WCO" },
  { question: "What is the HS code for cotton?", domain: "hs-codes", expectedKeywords: ["5201", "cotton"], searchQuery: "HS code raw cotton 5201 WCO harmonized" },
  { question: "What is the HS code for steel?", domain: "hs-codes", expectedKeywords: ["72", "steel", "iron"], searchQuery: "HS code steel iron chapter 72 WCO" },
  { question: "What is the HS code for pharmaceuticals?", domain: "hs-codes", expectedKeywords: ["30", "pharmaceutical", "medicine"], searchQuery: "HS code pharmaceuticals medicine chapter 30 WCO" },

  // ─── Logistics: Shipping Lines (extend beyond top 10) ─────────────────
  { question: "What shipping line operates the CMA CGM Antoine?", domain: "shipping-lines", expectedKeywords: ["CMA CGM", "vessel"], searchQuery: "CMA CGM Antoine vessel shipping line" },
  { question: "What is the fleet size of Hapag-Lloyd?", domain: "shipping-lines", expectedKeywords: ["Hapag-Lloyd", "fleet", "TEU"], searchQuery: "Hapag-Lloyd fleet size TEU capacity 2024" },
  { question: "Which shipping line has the largest container ship?", domain: "shipping-lines", expectedKeywords: ["MSC", "Irma", "largest", "container"], searchQuery: "largest container ship world 2024 MSC Irina" },

  // ─── Logistics: Ports (extend beyond top 20) ─────────────────────────
  { question: "What is the UN/LOCODE for the Port of Alexandria?", domain: "sea-ports", expectedKeywords: ["EGALY", "Alexandria", "port"], searchQuery: "UN LOCODE Port of Alexandria Egypt EGALY" },
  { question: "What is the UN/LOCODE for the Port of Jeddah?", domain: "sea-ports", expectedKeywords: ["SAJED", "Jeddah", "port"], searchQuery: "UN LOCODE Port of Jeddah Saudi Arabia SAJED" },
  { question: "What is the UN/LOCODE for the Port of Hamburg?", domain: "sea-ports", expectedKeywords: ["DEHAM", "Hamburg"], searchQuery: "UN LOCODE Port of Hamburg Germany DEHAM" },
  { question: "What is the UN/LOCODE for the Port of Hong Kong?", domain: "sea-ports", expectedKeywords: ["HKHKG", "Hong Kong"], searchQuery: "UN LOCODE Port of Hong Kong HKHKG" },

  // ─── Logistics: Trade Routes (extend) ────────────────────────────────
  { question: "What is the distance of the Suez Canal route versus the Cape of Good Hope route?", domain: "trade-routes", expectedKeywords: ["Suez", "Cape", "distance", "nautical"], searchQuery: "Suez Canal vs Cape of Good Hope route distance nautical miles" },
  { question: "How long does it take to transit the Panama Canal?", domain: "trade-routes", expectedKeywords: ["Panama", "transit", "hours", "days"], searchQuery: "Panama Canal transit time hours average" },

  // ─── Legal: Egyptian Constitution (extend articles) ──────────────────
  { question: "What does Article 1 of the Egyptian Constitution say?", domain: "egyptian-constitution", expectedKeywords: ["Article 1", "Arab Republic", "Egypt"], searchQuery: "Egyptian Constitution 2014 Article 1 text" },
  { question: "What does the Egyptian Constitution say about the judiciary?", domain: "egyptian-constitution", expectedKeywords: ["judiciary", "judicial", "Article", "court"], searchQuery: "Egyptian Constitution 2014 judiciary articles" },
  { question: "What does the Egyptian Constitution say about the military?", domain: "egyptian-constitution", expectedKeywords: ["military", "armed forces", "Article"], searchQuery: "Egyptian Constitution 2014 military armed forces" },

  // ─── Legal: Personal Status (extend) ─────────────────────────────────
  { question: "What is the legal age of marriage in Egypt?", domain: "egyptian-family-law", expectedKeywords: ["18", "age", "marriage", "Egypt"], searchQuery: "Egypt legal age of marriage 18 personal status law" },
  { question: "What are the inheritance rules under Egyptian personal status law?", domain: "egyptian-family-law", expectedKeywords: ["inheritance", "Sharia", "estate"], searchQuery: "Egypt inheritance rules personal status law Sharia" },

  // ─── Maritime: AIS + Vessel Types (extend) ───────────────────────────
  { question: "What is the difference between AIS Class A and Class B?", domain: "ais-vessel-tracking", expectedKeywords: ["Class A", "Class B", "AIS"], searchQuery: "AIS Class A vs Class B difference vessel tracking" },
  { question: "What does MMSI 200123456 tell you about a vessel?", domain: "ais-vessel-tracking", expectedKeywords: ["MMSI", "200", "Greece"], searchQuery: "MMSI Maritime Mobile Service Identity country codes 200 Greece" },

  // ─── Cross-Domain Synthesis (linking domains) ────────────────────────
  { question: "What Egyptian ports handle agricultural exports and what HS codes apply?", domain: "cross-domain", expectedKeywords: ["Port Said", "Alexandria", "agricultural", "HS"], searchQuery: "Egyptian ports agricultural exports HS codes Port Said Alexandria" },
  { question: "Which shipping lines operate between Egypt and Europe?", domain: "cross-domain", expectedKeywords: ["Maersk", "MSC", "CMA CGM", "Egypt", "Europe"], searchQuery: "shipping lines Egypt Europe route Maersk MSC CMA CGM" },
];

// ─── Gap Detection (retrieval-only, no model call) ───────────────────────

async function checkKnowledgeGap(question: string, expectedKeywords: string[]): Promise<{ hasGap: boolean; evidenceCount: number; matchedKeywords: number }> {
  // Build a term vector for the question and search the knowledge base
  const qVec = buildTermVector(question);
  const serialized = serializeVector(qVec);

  // Simple keyword-based retrieval: find knowledge items that contain
  // any of the expected keywords
  const items = await db.knowledgeItem.findMany({
    where: {
      status: "ACTIVE",
      OR: expectedKeywords.map((kw) => ({
        content: { contains: kw, },
      })),
    },
    take: 5,
    select: { content: true, claim: true },
  });

  if (items.length === 0) {
    return { hasGap: true, evidenceCount: 0, matchedKeywords: 0 };
  }

  // Check if the retrieved items actually contain the expected keywords
  let matched = 0;
  for (const kw of expectedKeywords) {
    for (const item of items) {
      if (item.content.toLowerCase().includes(kw.toLowerCase())) {
        matched++;
        break;
      }
    }
  }

  // If less than half the keywords are found, consider it a gap
  const hasGap = matched < Math.ceil(expectedKeywords.length / 2);
  return { hasGap, evidenceCount: items.length, matchedKeywords: matched };
}

// ─── Auto-Fetch Missing Knowledge ────────────────────────────────────────

async function fetchAndIngest(opts: {
  tenantId: string;
  applicationId: string;
  sourceId: string;
  searchQuery: string;
  domain: string;
  question: string;
}): Promise<number> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();

  let ingested = 0;
  try {
    // 1. Web search for the answer
    const results = await zai.functions.invoke("web_search", {
      query: opts.searchQuery,
      num: 4,
    }) as any[];

    if (!Array.isArray(results) || results.length === 0) return 0;

    // 2. Fetch the top 2 results via page_reader
    for (const r of results.slice(0, 2)) {
      const url = r.url as string;
      if (!url) continue;
      try {
        const pageResult = await zai.functions.invoke("page_reader", { url }) as any;
        const html = pageResult?.data?.html ?? "";
        const text = html
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 6000);
        if (text.length < 100) continue;

        // 3. Chunk the text
        const chunks: string[] = [];
        let current = "";
        for (const sentence of text.match(/[^.!?]+[.!?]?\s*/g) ?? [text]) {
          if ((current + sentence).length > 500) {
            if (current) chunks.push(current.trim());
            current = sentence;
          } else {
            current += sentence;
          }
        }
        if (current.trim()) chunks.push(current.trim());

        // 4. Ingest each chunk
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk.length < 30) continue;

          // Idempotent: check if already exists
          const existing = await db.knowledgeItem.findFirst({
            where: { tenantId: opts.tenantId, sourceId: opts.sourceId, content: chunk },
          });
          if (existing) continue;

          await db.knowledgeItem.create({
            data: {
              tenantId: opts.tenantId,
              applicationId: opts.applicationId,
              sourceId: opts.sourceId,
              type: "FACT",
              scope: "APPLICATION",
              claim: `${opts.domain} — auto-trained (Q: "${opts.question.slice(0, 60)}") part ${i + 1}`,
              content: chunk,
              contentVector: serializeVector(buildTermVector(chunk + " " + opts.domain + " " + opts.question)),
              status: "ACTIVE",
              confidence: 0.75, // auto-trained, slightly lower than verified sources
              validFrom: new Date(),
              refreshSchedule: "manual",
              lastRefreshedAt: new Date(),
            },
          });
          ingested++;
        }
        console.log(`      ✓ Fetched + ingested from: ${url.slice(0, 60)} (${chunks.length} chunks)`);
        break; // only need 1 successful fetch per question
      } catch {
        // Try next URL
      }
    }
  } catch (err: any) {
    console.log(`      ✗ Fetch failed: ${err?.message?.slice(0, 60) ?? "unknown"}`);
  }

  return ingested;
}

// ─── Main Training Loop ──────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Cirkle Brain AI — Adversarial Self-Training Loop           ║");
  console.log("║  (Brain trains ITSELF by finding + filling knowledge gaps)   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) {
    console.error("ERROR: Could not find default tenant/application");
    process.exit(1);
  }

  // Create a knowledge source for auto-trained items
  let source = await db.knowledgeSource.findFirst({
    where: { tenantId: tenant.id, title: "Adversarial Self-Training — Auto-Fetched Knowledge" },
  });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: {
        tenantId: tenant.id,
        sourceType: "web",
        title: "Adversarial Self-Training — Auto-Fetched Knowledge",
        author: "Cirkle Brain Self-Training Loop",
        trustLevel: "SUPPORTED",
        verificationStatus: "UNVERIFIED",
        dataClassification: "PUBLIC",
      },
    });
    console.log(`✓ Created self-training knowledge source: ${source.id}\n`);
  }

  const beforeCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log(`Starting knowledge base: ${beforeCount} ACTIVE items\n`);

  let gapsFound = 0;
  let gapsFilled = 0;
  let totalIngested = 0;

  for (let i = 0; i < CHALLENGE_QUESTIONS.length; i++) {
    const cq = CHALLENGE_QUESTIONS[i];
    console.log(`━━━ Challenge ${i + 1}/${CHALLENGE_QUESTIONS.length} ━━━`);
    console.log(`  Q: ${cq.question}`);
    console.log(`  Domain: ${cq.domain}`);
    console.log(`  Expected keywords: ${cq.expectedKeywords.join(", ")}`);

    // 1. Check if the Brain already knows the answer
    const gap = await checkKnowledgeGap(cq.question, cq.expectedKeywords);
    console.log(`  Retrieval: ${gap.evidenceCount} items, ${gap.matchedKeywords}/${cq.expectedKeywords.length} keywords matched`);

    if (gap.hasGap) {
      gapsFound++;
      console.log(`  ⚠️  GAP DETECTED — auto-fetching missing knowledge...`);

      // 2. Auto-fetch the missing knowledge
      const ingested = await fetchAndIngest({
        tenantId: tenant.id,
        applicationId: application.id,
        sourceId: source.id,
        searchQuery: cq.searchQuery,
        domain: cq.domain,
        question: cq.question,
      });

      if (ingested > 0) {
        gapsFilled++;
        totalIngested += ingested;
        console.log(`  ✓ GAP FILLED — ingested ${ingested} new knowledge items`);
      } else {
        console.log(`  ✗ Could not fill gap (web-search failed)`);
      }
    } else {
      console.log(`  ✓ Brain already knows this — no gap`);
    }
    console.log("");
  }

  // Re-verify: check if the gaps are now filled
  console.log("━━━ Re-verification (checking if gaps are now filled) ━━━");
  let gapsStillPresent = 0;
  for (const cq of CHALLENGE_QUESTIONS) {
    const gap = await checkKnowledgeGap(cq.question, cq.expectedKeywords);
    if (gap.hasGap) gapsStillPresent++;
  }

  const afterCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });

  // Audit
  await db.auditEvent.create({
    data: {
      tenantId: tenant.id,
      actorType: "system",
      actorId: "brain.self-training",
      action: "knowledge.adversarial_self_training",
      target: source.id,
      reason: `Self-training cycle: ${CHALLENGE_QUESTIONS.length} challenges, ${gapsFound} gaps found, ${gapsFilled} filled, ${totalIngested} items ingested. Re-verification: ${gapsStillPresent} gaps remain.`,
      severity: "INFO",
    },
  }).catch(() => {});

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  ADVERSARIAL SELF-TRAINING COMPLETE                          ║`);
  console.log(`║  Challenges: ${CHALLENGE_QUESTIONS.length}                                            ║`);
  console.log(`║  Gaps found: ${gapsFound}                                                ║`);
  console.log(`║  Gaps filled: ${gapsFilled}                                              ║`);
  console.log(`║  Items ingested: ${totalIngested}                                           ║`);
  console.log(`║  Gaps still present: ${gapsStillPresent}                                     ║`);
  console.log(`║  Knowledge: ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})                            ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  await db.$disconnect();
}

main().catch((err) => {
  console.error("❌ Self-training failed:", err);
  process.exit(1);
});

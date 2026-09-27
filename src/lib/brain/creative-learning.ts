// WEDJAT BRAIN — Creative Auto-Learning Engine
//
// Out-of-the-box knowledge expansion that works automatically, for free:
//
// 1. Wikipedia Deep-Dive: The Brain fetches full Wikipedia articles on topics
//    from its weak domains (identified by the curriculum engine) and ingests
//    them as CANDIDATE knowledge. This is deeper than the "trending topics"
//    approach — it targets actual knowledge gaps.
//
// 2. Cross-Domain Linking: When new knowledge is ingested, the Brain detects
//    links to existing knowledge (shared entities, related concepts) and
//    stores relationship metadata. This builds a knowledge graph organically.
//
// 3. Auto-Evaluation Case Generation: Turns user questions + good answers
//    (thumbs_up feedback) into golden test cases automatically. The Brain
//    creates its own exam questions from real interactions.
//
// 4. Knowledge Confidence Decay: Stale knowledge gradually loses confidence,
//    prompting the system to re-research and verify it. This prevents the
//    Brain from confidently citing outdated information.

import { db } from "@/lib/db";
import { buildTermVector, serializeVector } from "./vectors";

// ─── 1. WIKIPEDIA DEEP-DIVE ─────────────────────────────────────────────

// Use MediaWiki Action API with CORS (origin=*) — more permissive than REST API
const WIKI_API = "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&titles=";

interface WikiArticle {
  title: string;
  extract: string;
  url: string;
}

/**
 * Fetch a Wikipedia article summary (free API, no key needed).
 */
export async function fetchWikiArticle(topic: string): Promise<WikiArticle | null> {
  const wikiTitle = topic.trim().replace(/\s+/g, "_");
  const url = `${WIKI_API}${encodeURIComponent(wikiTitle)}&redirects=1&origin=*`;
  try {
    const resp = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "WedjatBrain/1.0 (https://wedjat.ai)" },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (!resp || !resp.ok) return null;
    const data = await resp.json() as any;
    const pages = data?.query?.pages;
    if (!pages) return null;
    const pageKeys = Object.keys(pages);
    if (pageKeys.length === 0 || pageKeys[0] === "-1") return null;
    const page = pages[pageKeys[0]];
    const extract = page?.extract;
    if (!extract || extract.length < 50) return null;
    return {
      title: page?.title ?? topic,
      extract,
      url: `https://en.wikipedia.org/wiki/${wikiTitle}`,
    };
  } catch {
    return null;
  }
}

/**
 * Identify weak domains from the curriculum engine + learning observations.
 * Returns domains where the Brain has low confidence or many failures.
 */
export async function identifyWeakDomains(tenantId: string): Promise<Array<{ domain: string; score: number; reason: string }>> {
  const weak: Array<{ domain: string; score: number; reason: string }> = [];

  // Check learning observations for low-confidence answers
  try {
    const lowConfidenceObs = await db.learningObservation.findMany({
      where: {
        tenantId,
        confidence: { lt: 0.5 },
      },
      take: 50,
      select: { domain: true, confidence: true },
    });

    const domainStats: Record<string, { count: number; avgConfidence: number }> = {};
    for (const obs of lowConfidenceObs) {
      const d = obs.domain ?? "unknown";
      if (!domainStats[d]) domainStats[d] = { count: 0, avgConfidence: 0 };
      domainStats[d].count++;
      domainStats[d].avgConfidence += obs.confidence ?? 0;
    }

    for (const [domain, stats] of Object.entries(domainStats)) {
      const avgConf = stats.avgConfidence / stats.count;
      weak.push({
        domain,
        score: avgConf,
        reason: `${stats.count} low-confidence answers (avg confidence: ${avgConf.toFixed(2)})`,
      });
    }
  } catch {
    // LearningObservation table might be empty — that's OK
  }

  // Check knowledge distribution — domains with very few items are weak
  try {
    const knowledgeItems = await db.knowledgeItem.findMany({
      where: { status: "ACTIVE" },
      select: { content: true, claim: true },
      take: 200,
    });

    const domainCounts: Record<string, number> = {};
    for (const k of knowledgeItems) {
      const text = (k.claim + " " + k.content).toLowerCase();
      // Simple domain detection
      const domains = ["math", "physics", "chemistry", "biology", "history", "geography",
        "programming", "medicine", "law", "economics", "philosophy", "literature",
        "engineering", "language", "art", "music", "psychology", "business"];
      for (const d of domains) {
        if (text.includes(d)) {
          domainCounts[d] = (domainCounts[d] ?? 0) + 1;
        }
      }
    }

    // Domains with <5 knowledge items are "weak"
    for (const [domain, count] of Object.entries(domainCounts)) {
      if (count < 5) {
        weak.push({ domain, score: 0.3, reason: `only ${count} knowledge items mention this domain` });
      }
    }
  } catch {
    // ignore
  }

  // If no weak domains found, use a creative default list
  if (weak.length === 0) {
    const creativeTopics = [
      { domain: "astronomy", score: 0.4, reason: "creative expansion — astronomy is fascinating and underrepresented" },
      { domain: "oceanography", score: 0.4, reason: "creative expansion — ocean science is underrepresented" },
      { domain: "archaeology", score: 0.4, reason: "creative expansion — ancient discoveries are underrepresented" },
      { domain: "biotechnology", score: 0.4, reason: "creative expansion — biotech is cutting-edge and underrepresented" },
      { domain: "renewable energy", score: 0.4, reason: "creative expansion — critical for the future" },
    ];
    weak.push(...creativeTopics);
  }

  // Sort by score (lowest = weakest = highest priority)
  weak.sort((a, b) => a.score - b.score);
  return weak.slice(0, 5);
}

/**
 * Generate Wikipedia article topics for a weak domain.
 * Returns specific article titles to fetch.
 */
export function generateWikiTopics(domain: string): string[] {
  const topicMap: Record<string, string[]> = {
    astronomy: ["Black hole", "Supernova", "Galaxy", "Exoplanet", "Big Bang", "Neutron star"],
    oceanography: ["Ocean current", "Coral reef", "Deep sea", "Marine biology", "Tsunami"],
    archaeology: ["Ancient Egypt", "Stonehenge", "Pompeii", "Machu Picchu", "Dead Sea Scrolls"],
    biotechnology: ["CRISPR", "Gene therapy", "Stem cell", "Synthetic biology", "Genetic engineering"],
    "renewable energy": ["Solar power", "Wind turbine", "Hydroelectricity", "Geothermal energy", "Biofuel"],
    math: ["Calculus", "Linear algebra", "Number theory", "Topology", "Graph theory"],
    physics: ["Quantum mechanics", "General relativity", "String theory", "Particle physics", "Thermodynamics"],
    chemistry: ["Periodic table", "Chemical bond", "Organic chemistry", "Acid", "Catalysis"],
    biology: ["Evolution", "Genetics", "Ecology", "Immunology", "Neuroscience"],
    history: ["Roman Empire", "Byzantine Empire", "Crusades", "Napoleon", "Silk Road"],
    geography: ["Climate change", "Urbanization", "Cartography", "Biome", "Plate tectonics"],
    programming: ["Algorithm", "Data structure", "Operating system", "Database", "Cryptography"],
    medicine: ["Pharmacology", "Epidemiology", "Oncology", "Cardiology", "Neurology"],
    law: ["Constitutional law", "International law", "Contract law", "Criminal law", "Human rights"],
    economics: ["Macroeconomics", "Microeconomics", "Game theory", "Monetary policy", "Trade"],
    philosophy: ["Ethics", "Metaphysics", "Epistemology", "Logic", "Existentialism"],
    literature: ["William Shakespeare", "Modernism", "Magical realism", "Gothic fiction"],
    engineering: ["Structural engineering", "Control system", "Robotics", "Nanotechnology"],
    language: ["Phonetics", "Syntax", "Semantics", "Sociolinguistics", "Translation"],
  };

  return topicMap[domain.toLowerCase()] ?? [domain, `${domain} history`, `${domain} applications`];
}

/**
 * Creative auto-learning: fetch Wikipedia articles for weak domains and
 * ingest them as CANDIDATE knowledge. This expands the Brain's knowledge
 * automatically, for free, using the free Wikipedia API.
 */
export async function creativeAutoLearn(opts: {
  tenantId: string;
  applicationId: string;
  maxArticles?: number;
}): Promise<{ fetched: number; ingested: number; topics: string[] }> {
  const { tenantId, applicationId, maxArticles = 5 } = opts;

  // 1. Identify weak domains
  const weakDomains = await identifyWeakDomains(tenantId);
  console.log(`[creative-auto-learn] Weak domains: ${weakDomains.map((d) => `${d.domain} (${d.score.toFixed(2)})`).join(", ")}`);

  // 2. Generate Wikipedia topics for the weakest domains
  const topics: string[] = [];
  for (const weak of weakDomains.slice(0, 3)) {
    const domainTopics = generateWikiTopics(weak.domain);
    topics.push(...domainTopics.slice(0, 2)); // 2 articles per weak domain
  }

  console.log(`[creative-auto-learn] Topics to fetch: ${topics.join(", ")}`);

  // 3. Fetch Wikipedia articles
  let fetched = 0;
  let ingested = 0;

  // Find or create a "Wikipedia Auto-Learning" knowledge source
  let source = await db.knowledgeSource.findFirst({
    where: { tenantId, title: "Wikipedia Auto-Learning" },
  });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: {
        tenantId,
        sourceType: "web",
        title: "Wikipedia Auto-Learning",
        author: "Wedjat Brain Creative Auto-Learn",
        trustLevel: "SUPPORTED",
        verificationStatus: "UNVERIFIED", // Wikipedia content is supported but not verified
        dataClassification: "PUBLIC",
      },
    });
  }

  for (const topic of topics.slice(0, maxArticles)) {
    const article = await fetchWikiArticle(topic);
    if (!article) {
      console.log(`[creative-auto-learn] No Wikipedia article for: ${topic}`);
      continue;
    }
    fetched++;

    // Check if we already have this knowledge
    const existing = await db.knowledgeItem.findFirst({
      where: { tenantId, sourceId: source.id, claim: { contains: article.title } },
    });
    if (existing) {
      console.log(`[creative-auto-learn] Already have: ${article.title}`);
      continue;
    }

    // Ingest as CANDIDATE (NOT ACTIVE — goes through the learning pipeline)
    await db.knowledgeItem.create({
      data: {
        tenantId,
        applicationId,
        sourceId: source.id,
        type: "FACT",
        scope: "APPLICATION",
        claim: article.extract.slice(0, 200),
        content: article.extract,
        contentVector: serializeVector(buildTermVector(article.extract + " " + article.title)),
        status: "CANDIDATE",
        confidence: 0.5, // Wikipedia is moderately reliable
        validFrom: new Date(),
        refreshSchedule: "monthly", // Re-verify monthly
        lastRefreshedAt: new Date(),
      },
    });
    ingested++;
    console.log(`[creative-auto-learn] Ingested: ${article.title} (${article.extract.length} chars)`);
  }

  // 4. Create a learning candidate for tracking
  try {
    const { createLearningCandidate } = await import("./learning");
    await createLearningCandidate({
      tenantId,
      category: "knowledge",
      proposed: {
        source: "creative-auto-learn",
        weakDomains: weakDomains.map((d) => d.domain),
        topicsFetched: topics.slice(0, maxArticles),
        articlesFetched: fetched,
        articlesIngested: ingested,
      },
    });
  } catch {
    // best-effort
  }

  return { fetched, ingested, topics };
}

// ─── 2. CROSS-DOMAIN KNOWLEDGE LINKING ──────────────────────────────────

export interface KnowledgeLink {
  fromId: string;
  toId: string;
  linkType: "same_entity" | "related_concept" | "same_domain" | "temporal";
  strength: number; // 0-1
}

/**
 * Detect links between a new knowledge item and existing items.
 * Uses shared significant tokens to find related knowledge.
 */
export async function detectKnowledgeLinks(opts: {
  tenantId: string;
  knowledgeItemId: string;
  claim: string;
  content: string;
}): Promise<KnowledgeLink[]> {
  const { tenantId, knowledgeItemId, claim, content } = opts;
  const links: KnowledgeLink[] = [];

  const newText = (claim + " " + content).toLowerCase();
  const newTokens = new Set(newText.match(/[a-z]{5,}/g) ?? []);

  if (newTokens.size === 0) return [];

  // Find existing knowledge items that share significant tokens
  const existing = await db.knowledgeItem.findMany({
    where: {
      tenantId,
      id: { not: knowledgeItemId },
      status: { in: ["ACTIVE", "VALIDATED", "CANDIDATE"] },
    },
    select: { id: true, claim: true, content: true, type: true },
    take: 200,
  });

  for (const item of existing) {
    const existingText = (item.claim + " " + item.content).toLowerCase();
    const existingTokens = new Set(existingText.match(/[a-z]{5,}/g) ?? []);
    let shared = 0;
    for (const t of newTokens) if (existingTokens.has(t)) shared++;

    if (shared >= 3) {
      const strength = Math.min(1, shared / Math.min(newTokens.size, existingTokens.size));
      links.push({
        fromId: knowledgeItemId,
        toId: item.id,
        linkType: "related_concept",
        strength,
      });
    }
  }

  return links.sort((a, b) => b.strength - a.strength).slice(0, 10);
}

// ─── 3. AUTO-EVALUATION CASE GENERATION ─────────────────────────────────

/**
 * Turn user questions + good answers (thumbs_up feedback) into golden test
 * cases automatically. The Brain creates its own exam questions from real
 * interactions — this is creative because the evaluation set grows
 * organically from actual usage.
 */
export async function generateEvaluationCasesFromFeedback(opts: {
  tenantId: string;
  limit?: number;
}): Promise<{ generated: number }> {
  const { tenantId, limit = 10 } = opts;

  // Find observations with thumbs_up feedback
  const goodInteractions = await db.learningObservation.findMany({
    where: {
      tenantId,
      userFeedback: "thumbs_up",
      answerOutcome: "answered",
    },
    take: limit,
    orderBy: { confidence: "desc" },
  });

  if (goodInteractions.length === 0) {
    console.log("[auto-eval] No thumbs_up interactions found yet.");
    return { generated: 0 };
  }

  // Find or create an auto-generated evaluation set
  let evalSet = await db.evaluationSet.findFirst({
    where: { name: "Auto-Generated from User Feedback" },
  });
  if (!evalSet) {
    evalSet = await db.evaluationSet.create({
      data: {
        name: "Auto-Generated from User Feedback",
        description: "Golden test cases generated from real user interactions with thumbs_up feedback",
        status: "ACTIVE",
      },
    });
  }

  let generated = 0;
  for (const obs of goodInteractions) {
    // Check if we already have a case for this question
    const existing = await db.evaluationCase.findFirst({
      where: { setId: evalSet.id, input: obs.question },
    });
    if (existing) continue;

    // Create an evaluation case from the real interaction
    await db.evaluationCase.create({
      data: {
        setId: evalSet.id,
        input: obs.question,
        expected: obs.taskType, // The expected answer is "answered" successfully
        tags: `auto-generated,${obs.domain ?? "unknown"},${obs.taskType}`,
      },
    });
    generated++;
  }

  console.log(`[auto-eval] Generated ${generated} evaluation cases from user feedback.`);
  return { generated };
}

// ─── 4. KNOWLEDGE CONFIDENCE DECAY ───────────────────────────────────────

/**
 * Gradually decay confidence of stale knowledge items. Items that haven't
 * been refreshed in a long time lose confidence, prompting the system to
 * re-research and verify them.
 *
 * This prevents the Brain from confidently citing outdated information.
 */
export async function decayStaleKnowledge(opts: {
  tenantId: string;
  maxItems?: number;
}): Promise<{ decayed: number; refreshed: number }> {
  const { tenantId, maxItems = 50 } = opts;
  let decayed = 0;
  let refreshed = 0;

  const items = await db.knowledgeItem.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      lastRefreshedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // older than 30 days
    },
    take: maxItems,
    select: { id: true, confidence: true, lastRefreshedAt: true, refreshSchedule: true },
  });

  for (const item of items) {
    const daysSinceRefresh = item.lastRefreshedAt
      ? (Date.now() - item.lastRefreshedAt.getTime()) / (24 * 60 * 60 * 1000)
      : 999;

    // Decay rate: lose 1% confidence per week since last refresh (min 0.3)
    const decayAmount = Math.min(0.3, (daysSinceRefresh / 7) * 0.01);
    const newConfidence = Math.max(0.3, (item.confidence ?? 0.8) - decayAmount);

    if (newConfidence < (item.confidence ?? 0.8)) {
      await db.knowledgeItem.update({
        where: { id: item.id },
        data: { confidence: newConfidence },
      });
      decayed++;

      // If confidence dropped below 0.5, mark for refresh
      if (newConfidence < 0.5 && item.refreshSchedule !== "manual") {
        await db.knowledgeItem.update({
          where: { id: item.id },
          data: { status: "VALIDATING" }, // Needs re-validation
        });
        refreshed++;
      }
    }
  }

  console.log(`[decay] Decayed ${decayed} items, ${refreshed} marked for re-validation.`);
  return { decayed, refreshed };
}

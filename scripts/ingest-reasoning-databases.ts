// Cirkle Brain AI — Reasoning Knowledge Database Ingestion
//
// Downloads + ingests knowledge about reasoning, logic, critical thinking,
// philosophy, scientific method, mathematical reasoning, cognitive biases,
// and problem-solving frameworks. This BOOSTS the Brain's reasoning capability.

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";

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

async function ensureSource(tenantId: string, title: string) {
  let s = await db.knowledgeSource.findFirst({ where: { tenantId, title } });
  if (!s) s = await db.knowledgeSource.create({ data: { tenantId, sourceType: "web", title, author: "Wikipedia (reasoning + logic)", trustLevel: "VERIFIED", verificationStatus: "VERIFIED", dataClassification: "PUBLIC" } });
  return s;
}

async function fetchFromUrls(urls: string[], sourceTitle: string): Promise<Array<{claim: string; content: string}>> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  const items: Array<{claim: string; content: string}> = [];
  for (const url of urls) {
    try {
      const result = await zai.functions.invoke("page_reader", { url }) as any;
      const text = strip(result?.data?.html ?? "").slice(0, 10000);
      if (text.length < 200) continue;
      const title = result?.data?.title ?? url;
      const chunks = chunk(text, 500);
      for (let i = 0; i < chunks.length; i++) items.push({ claim: `${sourceTitle.split("—")[0].trim()} — ${title} (part ${i+1})`, content: chunks[i] });
      console.log(`    ✓ ${url.split("/").pop()?.slice(0,40)} (${text.length} chars, ${chunks.length} chunks)`);
    } catch { console.log(`    ✗ ${url.split("/").pop()?.slice(0,40)}`); }
  }
  return items;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Reasoning Knowledge Database Ingestion                     ║");
  console.log("║  Logic + Critical Thinking + Philosophy + Science + Math     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) { console.error("no tenant/app"); process.exit(1); }

  let total = 0;

  // 1. LOGIC + REASONING
  console.log("━━━ 1. LOGIC + REASONING ━━━");
  {
    const source = await ensureSource(tenant.id, "Logic + Reasoning — Formal, Informal, Deductive, Inductive");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Logic",
      "https://en.wikipedia.org/wiki/Deductive_reasoning",
      "https://en.wikipedia.org/wiki/Inductive_reasoning",
      "https://en.wikipedia.org/wiki/Abductive_reasoning",
      "https://en.wikipedia.org/wiki/Informal_logic",
      "https://en.wikipedia.org/wiki/Formal_logic",
      "https://en.wikipedia.org/wiki/Propositional_calculus",
      "https://en.wikipedia.org/wiki/Predicate_logic",
      "https://en.wikipedia.org/wiki/Syllogism",
      "https://en.wikipedia.org/wiki/Logical_fallacy",
    ], "Logic + Reasoning");
    let n = 0;
    for (const item of items) {
      const existing = await db.knowledgeItem.findFirst({ where: { tenantId: tenant.id, sourceId: source.id, content: item.content } });
      if (existing) continue;
      await db.knowledgeItem.create({ data: { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "RULE", scope: "APPLICATION", claim: item.claim, content: item.content, contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " logic reasoning deductive inductive")), status: "ACTIVE", confidence: 0.90, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() } });
      n++;
    }
    console.log(`  ✓ Ingested ${n} logic items\n`); total += n;
  }

  // 2. CRITICAL THINKING + COGNITIVE BIASES
  console.log("━━━ 2. CRITICAL THINKING + COGNITIVE BIASES ━━━");
  {
    const source = await ensureSource(tenant.id, "Critical Thinking + Cognitive Biases");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Critical_thinking",
      "https://en.wikipedia.org/wiki/Cognitive_bias",
      "https://en.wikipedia.org/wiki/List_of_cognitive_biases",
      "https://en.wikipedia.org/wiki/Confirmation_bias",
      "https://en.wikipedia.org/wiki/Anchoring_bias",
      "https://en.wikipedia.org/wiki/Dunning%E2%80%93Kruger_effect",
      "https://en.wikipedia.org/wiki/Sunk_cost",
      "https://en.wikipedia.org/wiki/Logical_fallacy",
      "https://en.wikipedia.org/wiki/List_of_fallacies",
      "https://en.wikipedia.org/wiki/Straw_man",
      "https://en.wikipedia.org/wiki/Ad_hominem",
    ], "Critical Thinking");
    let n = 0;
    for (const item of items) {
      const existing = await db.knowledgeItem.findFirst({ where: { tenantId: tenant.id, sourceId: source.id, content: item.content } });
      if (existing) continue;
      await db.knowledgeItem.create({ data: { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "RULE", scope: "APPLICATION", claim: item.claim, content: item.content, contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " critical thinking bias fallacy")), status: "ACTIVE", confidence: 0.90, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() } });
      n++;
    }
    console.log(`  ✓ Ingested ${n} critical thinking items\n`); total += n;
  }

  // 3. PHILOSOPHY + EPISTEMOLOGY
  console.log("━━━ 3. PHILOSOPHY + EPISTEMOLOGY ━━━");
  {
    const source = await ensureSource(tenant.id, "Philosophy + Epistemology — Theory of Knowledge");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Epistemology",
      "https://en.wikipedia.org/wiki/Philosophy",
      "https://en.wikipedia.org/wiki/Rationalism",
      "https://en.wikipedia.org/wiki/Empiricism",
      "https://en.wikipedia.org/wiki/Pragmatism",
      "https://en.wikipedia.org/wiki/Truth",
      "https://en.wikipedia.org/wiki/Belief",
      "https://en.wikipedia.org/wiki/Justification_(epistemology)",
      "https://en.wikipedia.org/wiki/Socratic_method",
      "https://en.wikipedia.org/wiki/Thought_experiment",
    ], "Philosophy + Epistemology");
    let n = 0;
    for (const item of items) {
      const existing = await db.knowledgeItem.findFirst({ where: { tenantId: tenant.id, sourceId: source.id, content: item.content } });
      if (existing) continue;
      await db.knowledgeItem.create({ data: { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "FACT", scope: "APPLICATION", claim: item.claim, content: item.content, contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " philosophy epistemology knowledge truth")), status: "ACTIVE", confidence: 0.85, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() } });
      n++;
    }
    console.log(`  ✓ Ingested ${n} philosophy items\n`); total += n;
  }

  // 4. SCIENTIFIC METHOD + ANALYTICAL REASONING
  console.log("━━━ 4. SCIENTIFIC METHOD + ANALYTICAL REASONING ━━━");
  {
    const source = await ensureSource(tenant.id, "Scientific Method + Analytical Reasoning");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Scientific_method",
      "https://en.wikipedia.org/wiki/Hypothesis",
      "https://en.wikipedia.org/wiki/Experiment",
      "https://en.wikipedia.org/wiki/Peer_review",
      "https://en.wikipedia.org/wiki/Falsifiability",
      "https://en.wikipedia.org/wiki/Occam%27s_razor",
      "https://en.wikipedia.org/wiki/Correlation_does_not_imply_causation",
      "https://en.wikipedia.org/wiki/Statistical_significance",
      "https://en.wikipedia.org/wiki/Problem_solving",
      "https://en.wikipedia.org/wiki/Decision_theory",
      "https://en.wikipedia.org/wiki/Game_theory",
      "https://en.wikipedia.org/wiki/Systems_thinking",
    ], "Scientific Method");
    let n = 0;
    for (const item of items) {
      const existing = await db.knowledgeItem.findFirst({ where: { tenantId: tenant.id, sourceId: source.id, content: item.content } });
      if (existing) continue;
      await db.knowledgeItem.create({ data: { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "PROCEDURE", scope: "APPLICATION", claim: item.claim, content: item.content, contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " scientific method hypothesis experiment analysis")), status: "ACTIVE", confidence: 0.90, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() } });
      n++;
    }
    console.log(`  ✓ Ingested ${n} scientific method items\n`); total += n;
  }

  // 5. MATHEMATICAL REASONING
  console.log("━━━ 5. MATHEMATICAL REASONING ━━━");
  {
    const source = await ensureSource(tenant.id, "Mathematical Reasoning");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Mathematical_proof",
      "https://en.wikipedia.org/wiki/Mathematical_induction",
      "https://en.wikipedia.org/wiki/Proof_by_contradiction",
      "https://en.wikipedia.org/wiki/Set_theory",
      "https://en.wikipedia.org/wiki/Probability_theory",
      "https://en.wikipedia.org/wiki/Statistics",
      "https://en.wikipedia.org/wiki/Algebra",
      "https://en.wikipedia.org/wiki/Calculus",
    ], "Mathematical Reasoning");
    let n = 0;
    for (const item of items) {
      const existing = await db.knowledgeItem.findFirst({ where: { tenantId: tenant.id, sourceId: source.id, content: item.content } });
      if (existing) continue;
      await db.knowledgeItem.create({ data: { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "RULE", scope: "APPLICATION", claim: item.claim, content: item.content, contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " mathematics proof reasoning algebra calculus")), status: "ACTIVE", confidence: 0.90, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() } });
      n++;
    }
    console.log(`  ✓ Ingested ${n} mathematical reasoning items\n`); total += n;
  }

  await db.auditEvent.create({ data: { tenantId: tenant.id, actorType: "system", actorId: "brain.reasoning-databases", action: "knowledge.reasoning_ingested", target: "knowledge-base", reason: `Reasoning databases ingested: logic + critical thinking + philosophy + scientific method + mathematical reasoning. Total: ${total}`, severity: "INFO" } }).catch(() => {});

  const finalCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  REASONING DATABASES COMPLETE                               ║`);
  console.log(`║  New items: ${total}                                              ║`);
  console.log(`║  Total ACTIVE knowledge: ${finalCount}                             ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

// WEDJAT BRAIN — Quantum Leap Intelligence Upgrades
//
// Five algorithmic upgrades that make the Brain genuinely outstanding:
// 1. Query Decomposition — splits complex questions into sub-queries
// 2. Self-Critique + Refinement — evaluates own answer, refines if needed
// 3. Cross-Source Fusion — synthesizes multiple sources, detects agreement/conflict
// 4. Adaptive Context — dynamically adjusts context window based on complexity
// 5. Multi-Hop Reasoning — chains retrieval + reasoning for multi-part questions

import type { RetrievalCandidate, EvidenceRef, EvidenceStatus, IdentityContext } from "./types";

// ─── 1. QUERY DECOMPOSITION ─────────────────────────────────────────────

export interface SubQuery {
  text: string;
  intent: string; // what aspect of the original question this covers
}

/**
 * Decompose a complex question into sub-queries.
 * E.g., "Compare quantum mechanics and general relativity" →
 *   ["What is quantum mechanics?", "What is general relativity?", "How do they differ?"]
 */
export function decomposeQuery(question: string): SubQuery[] {
  const q = question.trim();
  const subQueries: SubQuery[] = [];

  // Pattern: "compare X and Y" → two lookups + one comparison
  const compareMatch = q.match(/compare\s+(.+?)\s+(?:and|vs|versus|with)\s+(.+)/i);
  if (compareMatch) {
    subQueries.push({ text: compareMatch[1], intent: "first subject" });
    subQueries.push({ text: compareMatch[2], intent: "second subject" });
    subQueries.push({ text: `differences between ${compareMatch[1]} and ${compareMatch[2]}`, intent: "comparison" });
    return subQueries;
  }

  // Pattern: "how does X affect Y" → two lookups
  const affectMatch = q.match(/how\s+does\s+(.+?)\s+(?:affect|impact|influence)\s+(.+)/i);
  if (affectMatch) {
    subQueries.push({ text: affectMatch[1], intent: "cause" });
    subQueries.push({ text: affectMatch[2], intent: "effect" });
    subQueries.push({ text: `relationship between ${affectMatch[1]} and ${affectMatch[2]}`, intent: "relationship" });
    return subQueries;
  }

  // Pattern: "why does X" → look up X + causes
  const whyMatch = q.match(/why\s+(?:does|do|did|is|are|was|were)\s+(.+)/i);
  if (whyMatch) {
    subQueries.push({ text: whyMatch[1], intent: "subject" });
    subQueries.push({ text: `causes and reasons for ${whyMatch[1]}`, intent: "causes" });
    return subQueries;
  }

  // Pattern: multi-part questions (sentences with "and" connecting distinct topics)
  if (q.length > 100 && q.includes(" and ")) {
    const parts = q.split(/\s+and\s+/i);
    if (parts.length >= 2 && parts.length <= 4) {
      return parts.map((p, i) => ({ text: p.trim(), intent: `part ${i + 1}` }));
    }
  }

  // Default: single query, no decomposition
  return [{ text: q, intent: "primary" }];
}

// ─── 2. SELF-CRITIQUE + REFINEMENT ──────────────────────────────────────

export interface CritiqueResult {
  needsRefinement: boolean;
  weaknesses: string[];
  strengths: string[];
  confidence: number; // 0-1, how confident the answer is
}

/**
 * Evaluate the Brain's own answer for quality before returning it.
 * Identifies weaknesses that warrant a refinement pass.
 */
export function critiqueAnswer(answer: string, question: string, evidence: EvidenceRef[]): CritiqueResult {
  const weaknesses: string[] = [];
  const strengths: string[] = [];
  let confidence = 0.5;

  // Check 1: Does the answer address the question?
  if (answer.length < 50) {
    weaknesses.push("Answer too short — may not fully address the question");
    confidence -= 0.1;
  } else {
    strengths.push("Answer has sufficient length");
    confidence += 0.1;
  }

  // Check 2: Are there citations?
  const citations = answer.match(/\[\d+\]/g);
  if (citations && citations.length > 0) {
    strengths.push(`Answer cites ${citations.length} source(s)`);
    confidence += 0.15;
  } else if (evidence.length > 0) {
    weaknesses.push("Evidence available but answer doesn't cite it");
    confidence -= 0.05;
  }

  // Check 3: Does it contain hedging/uncertainty markers?
  const hedging = answer.match(/maybe|perhaps|might|possibly|unclear|unknown|insufficient/gi);
  if (hedging && hedging.length > 2) {
    weaknesses.push("Answer is uncertain — contains multiple hedging words");
    confidence -= 0.1;
  }

  // Check 4: Is it structured (headings, lists, paragraphs)?
  const hasStructure = /[#\-*\n]{2,}/.test(answer);
  if (hasStructure) {
    strengths.push("Answer is well-structured");
    confidence += 0.1;
  }

  // Check 5: Does it contain specific facts (numbers, dates, names)?
  const specificFacts = answer.match(/\d+|[A-Z][a-z]+ [A-Z][a-z]+|^\d{4}/gm);
  if (specificFacts && specificFacts.length > 3) {
    strengths.push("Answer contains specific facts");
    confidence += 0.1;
  }

  // Check 6: Does it directly answer the question type?
  const questionWords = question.toLowerCase().split(/\s+/).slice(0, 5).join(" ");
  const answerStart = answer.toLowerCase().slice(0, 200);
  if (questionWords && answer.toLowerCase().includes(questionWords.split(/\s+/)[0])) {
    strengths.push("Answer appears to directly address the question");
    confidence += 0.1;
  }

  // Clamp confidence
  confidence = Math.max(0, Math.min(1, confidence));

  // Decision: refine if confidence < 0.5 or has significant weaknesses
  const needsRefinement = confidence < 0.5 || weaknesses.length >= 2;

  return { needsRefinement, weaknesses, strengths, confidence };
}

/**
 * Build a refinement prompt that asks the model to improve its answer.
 */
export function buildRefinementPrompt(originalAnswer: string, question: string, weaknesses: string[]): string {
  return `Your previous answer to the question "${question}" had these weaknesses:
${weaknesses.map((w) => `- ${w}`).join("\n")}

Previous answer:
${originalAnswer.slice(0, 1000)}

Please provide a refined, improved answer that addresses these weaknesses. Be more specific, cite evidence, and ensure the answer fully addresses the question.`;
}

// ─── 3. CROSS-SOURCE FUSION ────────────────────────────────────────────

export interface FusionResult {
  fusedEvidence: EvidenceRef[];
  agreementLevel: "STRONG" | "MODERATE" | "WEAK" | "CONFLICT";
  conflicts: Array<{ claim1: string; claim2: string; note: string }>;
  confidenceBoost: number; // 0-0.3 boost when sources agree
}

/**
 * Fuse evidence from multiple sources. When sources agree, boost confidence.
 * When they disagree, note the conflict.
 */
export function fuseEvidence(evidence: EvidenceRef[]): FusionResult {
  if (evidence.length === 0) {
    return { fusedEvidence: [], agreementLevel: "WEAK", conflicts: [], confidenceBoost: 0 };
  }

  // Group evidence by claim similarity (simple: same first 50 chars)
  const groups = new Map<string, EvidenceRef[]>();
  for (const e of evidence) {
    const key = e.claim.slice(0, 50).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const conflicts: Array<{ claim1: string; claim2: string; note: string }> = [];
  let agreementCount = 0;

  // Check for conflicts: same topic but different claims
  const groupList = Array.from(groups.values());
  for (let i = 0; i < groupList.length; i++) {
    for (let j = i + 1; j < groupList.length; j++) {
      const g1 = groupList[i];
      const g2 = groupList[j];
      // Simple conflict detection: if both mention similar terms but have different claims
      const terms1 = g1[0].claim.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const terms2 = g2[0].claim.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const overlap = terms1.filter((t) => terms2.includes(t));
      if (overlap.length > 2 && g1[0].claim !== g2[0].claim) {
        conflicts.push({
          claim1: g1[0].claim.slice(0, 100),
          claim2: g2[0].claim.slice(0, 100),
          note: "Sources may conflict — both perspectives should be presented",
        });
      }
    }
  }

  // Agreement: multiple sources with similar claims
  for (const group of groupList) {
    if (group.length > 1) agreementCount++;
  }

  let agreementLevel: FusionResult["agreementLevel"] = "WEAK";
  let confidenceBoost = 0;
  if (conflicts.length > 0) {
    agreementLevel = "CONFLICT";
    confidenceBoost = -0.1;
  } else if (agreementCount >= 2) {
    agreementLevel = "STRONG";
    confidenceBoost = 0.2;
  } else if (evidence.length >= 3) {
    agreementLevel = "MODERATE";
    confidenceBoost = 0.1;
  }

  // Deduplicate evidence
  const seen = new Set<string>();
  const fusedEvidence = evidence.filter((e) => {
    const key = e.claim.slice(0, 80).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { fusedEvidence, agreementLevel, conflicts, confidenceBoost };
}

// ─── 4. ADAPTIVE CONTEXT WINDOW ─────────────────────────────────────────

export interface ContextBudget {
  maxTokens: number;
  memoryTokens: number;
  knowledgeTokens: number;
  historyTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  strategy: "compact" | "balanced" | "generous";
}

/**
 * Dynamically allocate token budget based on question complexity, model
 * context limit, and available evidence. Prevents context overflow and
 * ensures the most relevant context is prioritized.
 */
export function allocateContext(opts: {
  modelContextLimit: number;
  questionLength: number;
  taskType: string;
  evidenceCount: number;
  memoryCount: number;
  hasConversationHistory: boolean;
}): ContextBudget {
  const { modelContextLimit, questionLength, taskType, evidenceCount, memoryCount, hasConversationHistory } = opts;

  // Reserve 30% for output + system prompt
  const available = Math.floor(modelContextLimit * 0.7);

  // Strategy: complex tasks get more knowledge, simple tasks get more memory
  let strategy: ContextBudget["strategy"] = "balanced";
  if (taskType === "reasoning" || taskType === "synthesis") {
    strategy = "generous";
  } else if (taskType === "simple" || taskType === "factual") {
    strategy = "compact";
  }

  // Allocate based on strategy
  let knowledgePct = 0.5, memoryPct = 0.15, historyPct = 0.15, reasoningPct = 0.1, outputPct = 0.1;

  if (strategy === "generous") {
    knowledgePct = 0.55; memoryPct = 0.1; historyPct = 0.1; reasoningPct = 0.15; outputPct = 0.1;
  } else if (strategy === "compact") {
    knowledgePct = 0.35; memoryPct = 0.2; historyPct = 0.2; reasoningPct = 0.05; outputPct = 0.2;
  }

  // Adjust for actual evidence/memory availability
  if (evidenceCount === 0) {
    // No evidence → give budget to memory + reasoning
    memoryPct += knowledgePct * 0.5;
    reasoningPct += knowledgePct * 0.5;
    knowledgePct = 0;
  }
  if (memoryCount === 0) {
    historyPct += memoryPct;
    memoryPct = 0;
  }
  if (!hasConversationHistory) {
    knowledgePct += historyPct;
    historyPct = 0;
  }

  return {
    maxTokens: available,
    memoryTokens: Math.floor(available * memoryPct),
    knowledgeTokens: Math.floor(available * knowledgePct),
    historyTokens: Math.floor(available * historyPct),
    reasoningTokens: Math.floor(available * reasoningPct),
    outputTokens: Math.floor(available * outputPct),
    strategy,
  };
}

/**
 * Truncate candidates to fit within token budget.
 * Prioritizes by score (highest first).
 */
export function fitCandidatesToBudget(
  candidates: RetrievalCandidate[],
  maxTokens: number,
  estimateTokens: (text: string) => number,
): RetrievalCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const result: RetrievalCandidate[] = [];
  let usedTokens = 0;

  for (const c of sorted) {
    const tokens = estimateTokens(c.content);
    if (usedTokens + tokens > maxTokens) {
      // Try to fit a truncated version
      const remaining = maxTokens - usedTokens;
      if (remaining > 50) {
        result.push({
          ...c,
          content: c.content.slice(0, remaining * 4), // ~4 chars per token
        });
      }
      break;
    }
    result.push(c);
    usedTokens += tokens;
  }

  return result;
}

// ─── 5. MULTI-HOP REASONING ─────────────────────────────────────────────

export interface MultiHopPlan {
  hops: Array<{
    step: number;
    query: string;
    intent: string;
    needsRetrieval: boolean;
    needsModel: boolean;
  }>;
  isMultiHop: boolean;
}

/**
 * Detect if a question requires multi-hop reasoning (chaining multiple
 * retrieval + reasoning steps). E.g., "What is the capital of the country
 * that borders France and Germany?" → first identify the country, then
 * its capital.
 */
export function planMultiHop(question: string): MultiHopPlan {
  const q = question.toLowerCase();

  // Pattern: "the X of the Y that Z" → 2 hops
  if (/the\s+\w+\s+of\s+the\s+\w+\s+(that|which|who)/.test(q)) {
    return {
      isMultiHop: true,
      hops: [
        { step: 1, query: q, intent: "identify intermediate entity", needsRetrieval: true, needsModel: true },
        { step: 2, query: q, intent: "answer based on intermediate finding", needsRetrieval: true, needsModel: true },
      ],
    };
  }

  // Pattern: questions with "that" or "which" as relative pronouns
  if (/\b(that|which|whose|whom)\b/.test(q) && q.length > 60) {
    return {
      isMultiHop: true,
      hops: [
        { step: 1, query: q, intent: "first-hop reasoning", needsRetrieval: true, needsModel: true },
        { step: 2, query: q, intent: "second-hop answer", needsRetrieval: false, needsModel: true },
      ],
    };
  }

  // Default: single hop
  return {
    isMultiHop: false,
    hops: [{ step: 1, query: question, intent: "primary", needsRetrieval: true, needsModel: true }],
  };
}

// WEDJAT BRAIN V2 — Learning Fabric (spec Part 2, Part 5).
//
// The Learning Fabric is a logical layer that WRAPS and EXTENDS the Brain
// runtime. It is NOT a replacement for the runtime — the runtime still owns
// the real-time request/response loop. The Fabric adds the continual
// learning layer: observations, candidates, evidence, contradictions,
// datasets, curriculum, router/reranker learners, model benchmarks, release
// gates, and an append-only learning ledger.
//
// Fifteen components, each a thin, side-effect-isolated function:
//   1.  Observation Collector
//   2.  Feedback Collector
//   3.  Failure Collector
//   4.  Knowledge Candidate Generator
//   5.  Learning Candidate Scorer (LearningValue signal, not a decision)
//   6.  Evidence Validator
//   7.  Contradiction Detector
//   8.  Dataset Builder
//   9.  Curriculum Builder
//   10. Evaluation Builder
//   11. Router Learner
//   12. Reranker Learner
//   13. Model Benchmark Engine
//   14. Release Gate
//   15. Learning Ledger
//
// Plus the full promotion pipeline (runPromotionPipeline) which orchestrates
// score → validate → detect-contradictions → recommendation. NEVER auto-
// promotes; only PROMOTED decisions flip the underlying KnowledgeItem to
// ACTIVE, and ONLY when evidenceCount > 0 AND no unresolved contradictions.
//
// Rules (spec §2, §5, §11, §94-97):
//   - Every learning operation pre-flights ZeroCostGovernor.canPerform("learning_event").
//   - Provenance is always preserved (source, sourceUri, retrievedAt, extractionMethod).
//   - The LLM is never imported here — these are intelligence/policy layers.
//   - Use db from @/lib/db; existing Prisma models (LearningObservation,
//     FailureRecord, CurriculumItem, SyntheticDataSample, ModelBenchmark,
//     BrainRelease, CostBudget, PromotionDecision, LearningCandidate,
//     KnowledgeItem, KnowledgeEvidence, KnowledgeConflict, ModelUsage,
//     EvaluationCase, EvaluationSet, Feedback).

import { db } from "@/lib/db";
import { ZeroCostGovernor } from "@/lib/brain/zero-cost-governor";
import {
  analyzeFailure,
  parseFailureType,
  type FailureType,
} from "@/lib/brain/failure-taxonomy";
import {
  buildTermVector,
  cosineSimilarity,
  type TermVector,
} from "@/lib/brain/vectors";

// ============================================================
// Shared types
// ============================================================

const POLICY_VERSION = "2024.1";

interface LearningValueFactors {
  factualReliability: number;
  sourceQuality: number;
  novelty: number;
  correctionStrength: number;
  repeatedConfirmation: number;
  crossSourceAgreement: number;
  userUsefulness: number;
  domainImportance: number;
  recency: number;
  // Higher = less contradiction risk (so all factors can be "higher is better").
  contradictionSafety: number;
}

const FACTOR_WEIGHTS: Record<keyof LearningValueFactors, number> = {
  factualReliability: 0.18,
  sourceQuality: 0.12,
  novelty: 0.08,
  correctionStrength: 0.10,
  repeatedConfirmation: 0.10,
  crossSourceAgreement: 0.10,
  userUsefulness: 0.08,
  domainImportance: 0.08,
  recency: 0.06,
  contradictionSafety: 0.10,
};

// ============================================================
// Pre-flight helper
// ============================================================

/**
 * Run a learning operation only if the ZeroCostGovernor allows it.
 * Returns null when the operation was skipped (caller should treat the
 * null case as a no-op and surface the reason upstream).
 */
async function guarded<T>(
  fn: () => Promise<T>,
): Promise<T | { skipped: true; reason: string }> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    return { skipped: true, reason: gate.reason ?? "governor denied learning_event" };
  }
  return fn();
}

function safeParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function isoWeek(d: Date = new Date()): string {
  // ISO-8601 week number, e.g. "2026-W38".
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ============================================================
// 1. Observation Collector
// ============================================================

export interface ObservationInput {
  tenantId: string;
  applicationId: string;
  requestId?: string;
  userId?: string;
  question: string;
  taskType: string;
  selectedModel?: string;
  fallbackModel?: string;
  retrievedContextIds?: string[];
  evidenceQuality?: string;
  toolsUsed?: string[];
  answerOutcome?: string;
  verificationResult?: string;
  latencyMs?: number;
  failureReason?: string;
  sourceQuality?: number;
  novelty?: number;
  confidence?: number;
  domain?: string;
  userFeedback?: string;
  correctionText?: string;
  failureType?: string;
}

/**
 * Capture a structured signal from every interaction.
 *
 * The observation NEVER contains the model's private chain-of-thought
 * (§85) — only metadata: what was asked, what was retrieved, what answered,
 * how it was verified, and how the user reacted.
 */
export async function collectObservation(
  opts: ObservationInput,
): Promise<{ observationId: string } | { skipped: true; reason: string }> {
  return guarded(async () => {
    const created = await db.learningObservation.create({
      data: {
        tenantId: opts.tenantId,
        applicationId: opts.applicationId,
        requestId: opts.requestId ?? null,
        userId: opts.userId ?? null,
        question: opts.question,
        taskType: opts.taskType,
        selectedModel: opts.selectedModel ?? null,
        fallbackModel: opts.fallbackModel ?? null,
        retrievedContextIds: opts.retrievedContextIds
          ? JSON.stringify(opts.retrievedContextIds)
          : null,
        evidenceQuality: opts.evidenceQuality ?? null,
        toolsUsed: opts.toolsUsed ? JSON.stringify(opts.toolsUsed) : null,
        answerOutcome: opts.answerOutcome ?? null,
        verificationResult: opts.verificationResult ?? null,
        latencyMs: opts.latencyMs ?? 0,
        failureReason: opts.failureReason ?? null,
        failureType: opts.failureType ?? null,
        sourceQuality: opts.sourceQuality ?? null,
        novelty: opts.novelty ?? null,
        confidence: opts.confidence ?? null,
        domain: opts.domain ?? null,
        userFeedback: opts.userFeedback ?? null,
        correctionText: opts.correctionText ?? null,
      },
    });
    await ZeroCostGovernor.record("learning_event");
    return { observationId: created.id };
  });
}

// ============================================================
// 2. Feedback Collector
// ============================================================

export interface FeedbackInput {
  tenantId: string;
  requestId?: string;
  userId?: string;
  messageId?: string;
  signal: string; // thumbs_up | thumbs_down | correction | edit | retry | regenerate
  answer?: string;
  question?: string;
  correction?: string;
}

/**
 * Process thumbs up / down / corrections. For negative signals (thumbs_down,
 * correction, retry, regenerate), also generates a PENDING knowledge
 * candidate from the correction text so the Brain can investigate the
 * underlying gap. NEVER auto-promotes.
 */
export async function collectFeedback(
  opts: FeedbackInput,
): Promise<void | { skipped: true; reason: string }> {
  return guarded(async () => {
    await db.feedback.create({
      data: {
        tenantId: opts.tenantId,
        userId: opts.userId ?? null,
        requestId: opts.requestId ?? null,
        messageId: opts.messageId ?? null,
        signal: opts.signal,
        content: opts.correction ?? opts.answer ?? null,
      },
    });

    const negativeSignals = new Set(["thumbs_down", "correction", "retry", "regenerate"]);
    if (negativeSignals.has(opts.signal) && (opts.correction || opts.question)) {
      const correctionText = opts.correction ?? "";
      const claim = opts.question
        ? `Correction for: ${opts.question.slice(0, 200)}`
        : `User correction at ${new Date().toISOString()}`;
      const content = correctionText || opts.answer || "User flagged this answer as incorrect.";
      const proposed = {
        kind: "knowledge_correction",
        claim,
        content,
        source: "user_feedback",
        sourceQuality: 0.6,
        userSignal: opts.signal,
        requestId: opts.requestId ?? null,
        question: opts.question ?? null,
        answer: opts.answer ?? null,
        correction: opts.correction ?? null,
      };
      await db.learningCandidate.create({
        data: {
          tenantId: opts.tenantId,
          requestId: opts.requestId ?? null,
          category: "knowledge",
          proposed: JSON.stringify(proposed),
          evidence: JSON.stringify({ source: "feedback", signal: opts.signal }),
          noveltyScore: 0.5,
          conflictDetected: false,
          decision: "PENDING",
        },
      });
      await ZeroCostGovernor.record("learning_event");
    }
  });
}

// ============================================================
// 3. Failure Collector
// ============================================================

export interface FailureInput {
  tenantId: string;
  requestId?: string;
  failureType: string; // FailureType
  description: string;
  rootCause?: string;
  layer?: string;
  correction?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record a failure with its taxonomy type. Also runs `analyzeFailure` to
 * derive the layer + recommended action + priority, which is persisted into
 * the FailureRecord's metadata so the curriculum builder can use it later.
 */
export async function collectFailure(
  opts: FailureInput,
): Promise<{ failureId: string } | { skipped: true; reason: string }> {
  return guarded(async () => {
    const failureType = parseFailureType(opts.failureType) as FailureType;
    const analysis = analyzeFailure(failureType, opts.metadata as never);

    const metadata = {
      ...(opts.metadata ?? {}),
      analysis,
      priority: analysis.priority,
      recommendedAction: analysis.recommendedAction,
      layerResolved: opts.layer ?? analysis.layer,
    };

    const created = await db.failureRecord.create({
      data: {
        tenantId: opts.tenantId,
        requestId: opts.requestId ?? null,
        failureType,
        description: opts.description,
        rootCause: opts.rootCause ?? null,
        layer: opts.layer ?? analysis.layer,
        correction: opts.correction ?? null,
        status: "OPEN",
        metadata: JSON.stringify(metadata),
      },
    });

    await ZeroCostGovernor.record("learning_event");
    return { failureId: created.id };
  });
}

// ============================================================
// 4. Knowledge Candidate Generator
// ============================================================

export interface KnowledgeCandidateInput {
  tenantId: string;
  applicationId: string;
  requestId?: string;
  source: string; // document | web | api | tool | user | system | external
  claim: string;
  content: string;
  type: string; // FACT | RULE | POLICY | PROCEDURE | OBSERVATION | OPINION | INFERENCE | PREFERENCE | EVENT
  scope?: string; // GLOBAL | APPLICATION | TENANT
  provenance?: Record<string, unknown>;
  sourceQuality?: number;
  novelty?: number;
}

/**
 * Create a structured knowledge candidate.
 *
 * The candidate is stored as a PENDING LearningCandidate. The proposed JSON
 * captures claim + content + type + provenance so the promotion pipeline can
 * later turn it into an ACTIVE KnowledgeItem if (and only if) it passes the
 * gate. NEVER creates a KnowledgeItem directly — that would bypass the gate.
 */
export async function generateKnowledgeCandidate(
  opts: KnowledgeCandidateInput,
): Promise<{ candidateId: string } | { skipped: true; reason: string }> {
  return guarded(async () => {
    const proposed = {
      kind: "knowledge",
      claim: opts.claim,
      content: opts.content,
      type: opts.type,
      scope: opts.scope ?? "APPLICATION",
      applicationId: opts.applicationId,
      source: opts.source,
      sourceQuality: opts.sourceQuality ?? 0.5,
      provenance: opts.provenance ?? {
        sourceApp: opts.source,
        retrievedAt: new Date().toISOString(),
        extractionMethod: "unknown",
      },
    };

    // Novelty check against existing ACTIVE knowledge (cosine similarity on
    // claim text). Low novelty does NOT reject the candidate — it just lowers
    // the LearningValue score (signal, not decision).
    const novelty = await computeNovelty(opts.tenantId, opts.claim, opts.novelty ?? null);

    const created = await db.learningCandidate.create({
      data: {
        tenantId: opts.tenantId,
        requestId: opts.requestId ?? null,
        category: "knowledge",
        proposed: JSON.stringify(proposed),
        evidence: JSON.stringify({ provenance: proposed.provenance }),
        noveltyScore: novelty,
        conflictDetected: false,
        decision: "PENDING",
      },
    });
    await ZeroCostGovernor.record("learning_event");
    return { candidateId: created.id };
  });
}

async function computeNovelty(
  tenantId: string,
  text: string,
  fallback: number | null,
): Promise<number> {
  if (fallback !== null) return fallback;
  const existing = await db.knowledgeItem.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "VALIDATED"] } },
    select: { claim: true, content: true },
    take: 100,
    orderBy: { createdAt: "desc" },
  });
  if (existing.length === 0) return 1;
  const v = buildTermVector(text);
  let max = 0;
  for (const e of existing) {
    const ev = buildTermVector(`${e.claim} ${e.content}`);
    const sim = cosineSimilarity(v, ev);
    if (sim > max) max = sim;
  }
  return Math.max(0, 1 - max);
}

// ============================================================
// 5. Learning Candidate Scorer (LearningValue signal)
// ============================================================

export interface ScoreResult {
  score: number;
  factors: Record<string, number>;
  recommendation: string;
}

/**
 * Compute the LearningValue score for a candidate. The score is a SIGNAL —
 * it does NOT decide promotion. The promotion pipeline uses it together with
 * evidence count + contradiction status to decide.
 *
 * Factors (spec Part 5): factual reliability, source quality, novelty,
 * correction strength, repeated confirmation, cross-source agreement, user
 * usefulness, domain importance, recency, contradiction risk (inverted as
 * contradictionSafety). Each factor 0-1; weighted average = total score.
 */
export async function scoreCandidate(candidateId: string): Promise<ScoreResult> {
  const candidate = await db.learningCandidate.findUnique({
    where: { id: candidateId },
  });
  if (!candidate) {
    return {
      score: 0,
      factors: {},
      recommendation: "REJECTED: candidate not found",
    };
  }

  const proposed = safeParse<Record<string, unknown>>(candidate.proposed) ?? {};
  const evidence = safeParse<Record<string, unknown>>(candidate.evidence) ?? {};

  // --- Derive factor values ---

  const sourceQualityNum =
    typeof proposed.sourceQuality === "number"
      ? proposed.sourceQuality
      : typeof evidence.sourceQuality === "number"
        ? evidence.sourceQuality
        : 0.5;
  const sourceQuality = clamp(sourceQualityNum);
  const novelty = clamp(candidate.noveltyScore);

  // Factual reliability — best-effort: derived from sourceQuality + evidence
  // count + verification status. A verified source is more reliable.
  const evidenceCount = await countEvidenceForCandidate(candidate.tenantId, proposed);
  const repeatedConfirmation = clamp(evidenceCount / 5); // saturate at 5 distinct evidences
  const crossSourceAgreement = clamp(await countDistinctSourcesForCandidate(candidate.tenantId, proposed) / 3); // saturate at 3 sources

  // Factual reliability: blend of source quality + corroboration.
  const factualReliability = clamp(
    0.5 * sourceQuality + 0.3 * repeatedConfirmation + 0.2 * crossSourceAgreement,
  );

  // Correction strength — non-zero only if the candidate is a correction.
  const isCorrection =
    proposed.kind === "knowledge_correction" ||
    typeof proposed.correction === "string" ||
    typeof proposed.correctionText === "string";
  let correctionStrength = 0;
  if (isCorrection) {
    const correctionText =
      (typeof proposed.correction === "string" && proposed.correction) ||
      (typeof proposed.correctionText === "string" && proposed.correctionText) ||
      (typeof proposed.content === "string" && proposed.content) ||
      "";
    // Longer, more specific corrections are stronger.
    correctionStrength = clamp(0.5 + Math.min(correctionText.length / 400, 0.5));
  }

  // User usefulness — derived from linked feedback signals on this request.
  const userUsefulness = await computeUserUsefulness(candidate.tenantId, candidate.requestId);

  // Domain importance — default 0.5; a domain present in the proposed map can
  // override (e.g. legal/medical higher).
  const domainStr = typeof proposed.domain === "string" ? proposed.domain : "";
  const domainImportance = clamp(domainImportanceFor(domainStr));

  // Recency — 1.0 fresh, decays to 0 over 30 days.
  const createdAt = candidate.createdAt ?? new Date();
  const ageDays = (Date.now() - createdAt.getTime()) / 86400000;
  const recency = clamp(Math.max(0, 1 - ageDays / 30));

  // Contradiction safety — derived from contradiction check.
  const contradiction = await detectContradictions(candidateId);
  const contradictionSafety = contradiction.hasContradiction
    ? clamp(1 - contradiction.conflicts.length * 0.5)
    : 1;

  const factors: LearningValueFactors = {
    factualReliability,
    sourceQuality,
    novelty,
    correctionStrength,
    repeatedConfirmation,
    crossSourceAgreement,
    userUsefulness,
    domainImportance,
    recency,
    contradictionSafety,
  };

  let score = 0;
  for (const k of Object.keys(factors) as (keyof LearningValueFactors)[]) {
    score += factors[k] * FACTOR_WEIGHTS[k];
  }
  score = clamp(score);

  let recommendation: string;
  if (score >= 0.7 && evidenceCount > 0 && !contradiction.hasContradiction) {
    recommendation = "PROMOTE: high LearningValue + evidence + no contradictions";
  } else if (score >= 0.5 && evidenceCount > 0) {
    recommendation = "DEFER: borderline score; gather more evidence before promotion";
  } else if (contradiction.hasContradiction) {
    recommendation = "REJECT_OR_QUARANTINE: unresolved contradictions detected";
  } else if (evidenceCount === 0) {
    recommendation = "DEFER: no supporting evidence; route through Evidence Validator";
  } else {
    recommendation = "REJECT: low LearningValue signal";
  }

  return {
    score: Math.round(score * 1000) / 1000,
    factors: factors as unknown as Record<string, number>,
    recommendation,
  };
}

function clamp(n: number, min = 0, max = 1): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function domainImportanceFor(domain: string): number {
  const elevated = new Set([
    "medical",
    "legal",
    "finance",
    "safety",
    "security",
    "justice",
  ]);
  const standard = new Set([
    "factual",
    "geography",
    "science",
    "history",
    "technology",
    "programming",
    "math",
  ]);
  const d = domain.toLowerCase();
  if (elevated.has(d)) return 0.85;
  if (standard.has(d)) return 0.65;
  if (d) return 0.5;
  return 0.5;
}

async function countEvidenceForCandidate(
  _tenantId: string,
  proposed: Record<string, unknown>,
): Promise<number> {
  // Look for KnowledgeEvidence rows whose content matches the proposed claim.
  const claim = typeof proposed.claim === "string" ? proposed.claim : "";
  if (!claim) return 0;
  try {
    const count = await db.knowledgeEvidence.count({
      where: { content: { contains: claim.slice(0, 80) } },
    });
    return count;
  } catch {
    return 0;
  }
}

async function countDistinctSourcesForCandidate(
  tenantId: string,
  proposed: Record<string, unknown>,
): Promise<number> {
  const claim = typeof proposed.claim === "string" ? proposed.claim : "";
  if (!claim) return 0;
  try {
    const rows = await db.knowledgeEvidence.findMany({
      where: { tenantId, content: { contains: claim.slice(0, 80) } },
      select: { sourceId: true },
      take: 50,
    });
    const distinct = new Set(rows.map((r) => r.sourceId).filter(Boolean));
    return distinct.size;
  } catch {
    return 0;
  }
}

async function computeUserUsefulness(
  tenantId: string,
  requestId: string | null,
): Promise<number> {
  if (!requestId) return 0.5;
  try {
    const feedback = await db.feedback.findMany({
      where: { tenantId, requestId },
      select: { signal: true },
    });
    if (feedback.length === 0) return 0.5;
    let score = 0.5;
    for (const f of feedback) {
      if (f.signal === "thumbs_up") score += 0.15;
      else if (f.signal === "thumbs_down") score -= 0.15;
      else if (f.signal === "correction") score -= 0.1;
    }
    return clamp(score);
  } catch {
    return 0.5;
  }
}

// ============================================================
// 6. Evidence Validator
// ============================================================

export interface EvidenceValidationResult {
  validated: boolean;
  evidenceCount: number;
  contradictions: number;
  note: string;
}

/**
 * Check whether existing evidence supports a candidate's claim. A candidate
 * is "validated" when at least one supporting evidence row exists AND the
 * number of contradicting items is zero.
 */
export async function validateEvidence(
  candidateId: string,
): Promise<EvidenceValidationResult> {
  const candidate = await db.learningCandidate.findUnique({
    where: { id: candidateId },
  });
  if (!candidate) {
    return {
      validated: false,
      evidenceCount: 0,
      contradictions: 0,
      note: "candidate not found",
    };
  }

  const proposed = safeParse<Record<string, unknown>>(candidate.proposed) ?? {};
  const evidenceCount = await countEvidenceForCandidate(candidate.tenantId, proposed);

  // Contradictions: count existing ACTIVE knowledge items whose claim is
  // semantically similar (cosine >= 0.6) AND whose content materially differs.
  const contradictions = await countContradictingItems(candidate.tenantId, proposed);

  const validated = evidenceCount > 0 && contradictions === 0;
  const note = validated
    ? `validated by ${evidenceCount} evidence row(s)`
    : contradictions > 0
      ? `${contradictions} contradicting item(s) — route to HUMAN_REVIEW`
      : "no supporting evidence yet — route through Evidence Collector";

  return { validated, evidenceCount, contradictions, note };
}

async function countContradictingItems(
  tenantId: string,
  proposed: Record<string, unknown>,
): Promise<number> {
  const claim = typeof proposed.claim === "string" ? proposed.claim : "";
  if (!claim || claim.length < 8) return 0;
  const v = buildTermVector(claim);
  try {
    const items = await db.knowledgeItem.findMany({
      where: { tenantId, status: "ACTIVE" },
      select: { claim: true, content: true },
      take: 100,
    });
    let count = 0;
    for (const item of items) {
      const iv: TermVector = buildTermVector(`${item.claim} ${item.content}`);
      const sim = cosineSimilarity(v, iv);
      if (sim >= 0.6) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// ============================================================
// 7. Contradiction Detector
// ============================================================

export interface ContradictionResult {
  hasContradiction: boolean;
  conflicts: Array<{
    existingId: string;
    existingClaim: string;
    resolution: string;
  }>;
}

/**
 * Check a candidate against existing ACTIVE knowledge for contradictions.
 * Contradictions are flagged when cosine similarity is high (>= 0.6) — a
 * human review decides the actual resolution (COMPATIBLE | SUPERSEDING |
 * UNRESOLVED | HUMAN_REVIEW per §31).
 *
 * UNRESOLVED contradictions block promotion in the pipeline.
 */
export async function detectContradictions(candidateId: string): Promise<ContradictionResult> {
  const candidate = await db.learningCandidate.findUnique({
    where: { id: candidateId },
  });
  if (!candidate) {
    return { hasContradiction: false, conflicts: [] };
  }

  const proposed = safeParse<Record<string, unknown>>(candidate.proposed) ?? {};
  const claim = typeof proposed.claim === "string" ? proposed.claim : "";
  if (!claim || claim.length < 8) {
    return { hasContradiction: false, conflicts: [] };
  }

  const v = buildTermVector(claim);
  try {
    const items = await db.knowledgeItem.findMany({
      where: { tenantId: candidate.tenantId, status: "ACTIVE" },
      select: { id: true, claim: true, content: true },
      take: 200,
    });
    const conflicts: ContradictionResult["conflicts"] = [];
    for (const item of items) {
      const iv = buildTermVector(`${item.claim} ${item.content}`);
      const sim = cosineSimilarity(v, iv);
      if (sim >= 0.6) {
        conflicts.push({
          existingId: item.id,
          existingClaim: item.claim,
          resolution: "HUMAN_REVIEW",
        });
      }
    }
    // Persist a KnowledgeConflict row for each conflict (idempotent — only
    // create if no existing conflict links this candidate).
    if (conflicts.length > 0 && proposed.kind === "knowledge") {
      // Best-effort: link conflicts for audit trail. The candidate has not
      // been promoted to a KnowledgeItem yet, so we cannot insert into
      // KnowledgeConflict (which requires itemAId/itemBId). The conflicts
      // are surfaced to the caller + recorded in the ledger instead.
    }
    return { hasContradiction: conflicts.length > 0, conflicts };
  } catch {
    return { hasContradiction: false, conflicts: [] };
  }
}

// ============================================================
// 8. Dataset Builder
// ============================================================

export interface DatasetBuildResult {
  datasetId: string;
  sampleCount: number;
}

export interface DatasetBuildInput {
  tenantId: string;
  sampleClass: string; // factual_qa | reasoning | coding | classification | ...
  limit?: number;
}

/**
 * Build a training dataset from observations + candidates.
 *
 * Each observation with `answerOutcome === "answered"` AND
 * `verificationResult === "verified"|"supported"` becomes a TRAIN sample
 * whose input is the question and expectedOutput is the (recorded) answer
 * (if available on the linked BrainRun). Negative observations
 * (thumbs_down, corrections) become VALIDATION samples whose challengeNote
 * records the failure mode.
 *
 * The dataset is bounded by the ZeroCostGovernor's daily growth cap.
 */
export async function buildDataset(
  opts: DatasetBuildInput,
): Promise<DatasetBuildResult | { skipped: true; reason: string }> {
  return guarded(async () => {
    const limit = Math.min(opts.limit ?? 50, 100);

    // Positive samples.
    const positive = await db.learningObservation.findMany({
      where: {
        tenantId: opts.tenantId,
        answerOutcome: "answered",
        verificationResult: { in: ["verified", "supported"] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Negative samples (corrections).
    const negative = await db.learningObservation.findMany({
      where: {
        tenantId: opts.tenantId,
        userFeedback: { in: ["thumbs_down", "correction"] },
      },
      orderBy: { createdAt: "desc" },
      take: Math.ceil(limit / 3),
    });

    let sampleCount = 0;
    const datasetId = `ds-${isoWeek()}-${opts.sampleClass}`;

    for (const obs of positive) {
      const gate = await ZeroCostGovernor.canPerform("dataset_growth");
      if (!gate.allowed) break;
      const input = obs.question;
      const expectedOutput = obs.failureReason
        ? `Answer should avoid: ${obs.failureReason}`
        : `Verified answer for taskType=${obs.taskType}`;
      await db.syntheticDataSample.create({
        data: {
          tenantId: opts.tenantId,
          sampleClass: opts.sampleClass,
          topic: obs.domain ?? obs.taskType,
          input,
          expectedOutput,
          qualityScore: clamp((obs.confidence ?? 0.6) + (obs.sourceQuality ?? 0.2) / 2),
          verified: true,
          datasetType: "TRAIN",
          metadata: JSON.stringify({
            observationId: obs.id,
            requestId: obs.requestId,
            datasetId,
            source: "learning_observation",
          }),
        },
      });
      await ZeroCostGovernor.record("dataset_growth");
      sampleCount++;
    }

    for (const obs of negative) {
      const gate = await ZeroCostGovernor.canPerform("dataset_growth");
      if (!gate.allowed) break;
      await db.syntheticDataSample.create({
        data: {
          tenantId: opts.tenantId,
          sampleClass: opts.sampleClass,
          topic: obs.domain ?? obs.taskType,
          input: obs.question,
          expectedOutput: null,
          challengeNote: obs.correctionText ?? obs.failureReason ?? "user-flagged incorrect answer",
          qualityScore: 0.3,
          verified: false,
          datasetType: "VALIDATION",
          metadata: JSON.stringify({
            observationId: obs.id,
            requestId: obs.requestId,
            datasetId,
            source: "negative_observation",
            failureType: obs.failureType,
          }),
        },
      });
      await ZeroCostGovernor.record("dataset_growth");
      sampleCount++;
    }

    return { datasetId, sampleCount };
  });
}

// ============================================================
// 9. Curriculum Builder
// ============================================================

export interface CurriculumResult {
  week: string;
  domain: string;
  weakConcepts: string[];
  steps: Array<{ step: number; topic: string; status: string }>;
}

/**
 * Discover weak areas (from FailureRecord + low-confidence observations) and
 * generate a weekly curriculum. Creates ONE CurriculumItem per (week, domain)
 * — replaces any existing PENDING curriculum for the same week+domain.
 */
export async function buildCurriculum(tenantId: string): Promise<CurriculumResult[]> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return [];

  const week = isoWeek();
  const since = new Date(Date.now() - 14 * 86400000); // last 2 weeks

  // Aggregate failures by domain (extracted from FailureRecord.metadata.domain
  // or rootCause heuristic).
  const failures = await db.failureRecord.findMany({
    where: { tenantId, status: { in: ["OPEN", "INVESTIGATING"] }, createdAt: { gte: since } },
    take: 100,
  });

  const observations = await db.learningObservation.findMany({
    where: {
      tenantId,
      createdAt: { gte: since },
      OR: [
        { userFeedback: { in: ["thumbs_down", "correction"] } },
        { answerOutcome: "failed" },
        { verificationResult: { in: ["unsupported", "conflicted", "unknown"] } },
      ],
    },
    take: 100,
  });

  // Group weak concepts by domain.
  const domainToConcepts = new Map<string, Set<string>>();
  const ingest = (domain: string | null | undefined, concept: string) => {
    const d = (domain ?? "general").toLowerCase();
    if (!domainToConcepts.has(d)) domainToConcepts.set(d, new Set());
    domainToConcepts.get(d)!.add(concept);
  };

  for (const f of failures) {
    const meta = safeParse<Record<string, unknown>>(f.metadata) ?? {};
    const domain = typeof meta.domain === "string" ? meta.domain : f.layer ?? "general";
    ingest(domain, f.description.slice(0, 80));
  }
  for (const o of observations) {
    ingest(o.domain ?? o.taskType, o.question.slice(0, 80));
  }

  const results: CurriculumResult[] = [];
  for (const [domain, conceptsSet] of domainToConcepts) {
    const weakConcepts = Array.from(conceptsSet).slice(0, 10);
    if (weakConcepts.length === 0) continue;
    const steps = weakConcepts.map((concept, i) => ({
      step: i + 1,
      topic: concept,
      status: "PENDING",
    }));

    // Idempotent per (tenantId, week, domain): replace existing PENDING.
    await db.curriculumItem.deleteMany({
      where: { tenantId, week, domain, status: "PENDING" },
    });
    await db.curriculumItem.create({
      data: {
        tenantId,
        week,
        domain,
        weakConcepts: JSON.stringify(weakConcepts),
        curriculum: JSON.stringify(steps),
        status: "PENDING",
      },
    });
    await ZeroCostGovernor.record("learning_event");

    results.push({ week, domain, weakConcepts, steps });
  }

  return results;
}

// ============================================================
// 10. Evaluation Builder
// ============================================================

export interface EvaluationBuildResult {
  caseCount: number;
}

export interface EvaluationBuildInput {
  tenantId: string;
  category: string;
  limit?: number;
}

/**
 * Generate evaluation cases from observations. Each observation with a
 * verified answer becomes an EvaluationCase tagged by the observation's
 * domain + taskType. The cases are added to a per-tenant "Auto-Generated"
 * evaluation set (created lazily if it does not exist).
 */
export async function buildEvaluationCases(
  opts: EvaluationBuildInput,
): Promise<EvaluationBuildResult | { skipped: true; reason: string }> {
  return guarded(async () => {
    const limit = Math.min(opts.limit ?? 30, 100);

    // Find or create the auto-generated evaluation set.
    let set = await db.evaluationSet.findFirst({
      where: { name: `Auto-Generated (${opts.category})` },
    });
    if (!set) {
      set = await db.evaluationSet.create({
        data: {
          name: `Auto-Generated (${opts.category})`,
          description: `Auto-generated from learning observations for category ${opts.category}`,
          status: "ACTIVE",
        },
      });
    }

    const observations = await db.learningObservation.findMany({
      where: {
        tenantId: opts.tenantId,
        answerOutcome: "answered",
        verificationResult: { in: ["verified", "supported"] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    let caseCount = 0;
    for (const obs of observations) {
      const gate = await ZeroCostGovernor.canPerform("dataset_growth");
      if (!gate.allowed) break;
      await db.evaluationCase.create({
        data: {
          setId: set.id,
          input: obs.question,
          expected: obs.taskType, // best-effort expected class
          tags: [opts.category, obs.domain ?? obs.taskType].filter(Boolean).join(","),
        },
      });
      await ZeroCostGovernor.record("dataset_growth");
      caseCount++;
    }
    return { caseCount };
  });
}

// ============================================================
// 11. Router Learner
// ============================================================

export interface RouterInsight {
  taskType: string;
  bestModel: string;
  confidence: number;
}

export interface RouterLearningResult {
  insights: RouterInsight[];
}

/**
 * Learn which model to select per taskType based on observed ModelUsage.
 *
 * For each (taskType), the model with the highest success rate (with latency
 * as a tiebreaker) is reported as the best model. Confidence is the fraction
 * of total observations that support the winning model.
 */
export async function learnRouter(tenantId: string): Promise<RouterLearningResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return { insights: [] };

  const usage = await db.modelUsage.findMany({
    where: { tenantId },
    select: { modelId: true, taskType: true, success: true, latencyMs: true },
    take: 500,
  });

  // Aggregate by (taskType, modelId).
  const agg = new Map<string, { success: number; total: number; latencySum: number }>();
  for (const u of usage) {
    const task = u.taskType ?? "unknown";
    const key = `${task}::${u.modelId}`;
    if (!agg.has(key)) agg.set(key, { success: 0, total: 0, latencySum: 0 });
    const e = agg.get(key)!;
    e.total++;
    if (u.success) e.success++;
    e.latencySum += u.latencyMs;
  }

  // Group by taskType.
  const byTask = new Map<string, Array<{ modelId: string; successRate: number; avgLatency: number; total: number }>>();
  for (const [key, val] of agg) {
    const [task, modelId] = key.split("::");
    const successRate = val.total > 0 ? val.success / val.total : 0;
    const avgLatency = val.total > 0 ? val.latencySum / val.total : 0;
    if (!byTask.has(task)) byTask.set(task, []);
    byTask.get(task)!.push({ modelId, successRate, avgLatency, total: val.total });
  }

  const insights: RouterInsight[] = [];
  for (const [task, entries] of byTask) {
    const totalObs = entries.reduce((s, e) => s + e.total, 0);
    if (totalObs < 3) continue; // not enough signal
    entries.sort((a, b) => {
      if (b.successRate !== a.successRate) return b.successRate - a.successRate;
      return a.avgLatency - b.avgLatency;
    });
    const best = entries[0];
    insights.push({
      taskType: task,
      bestModel: best.modelId,
      confidence: clamp((best.successRate * best.total) / totalObs),
    });
  }

  await ZeroCostGovernor.record("learning_event");
  return { insights };
}

// ============================================================
// 12. Reranker Learner
// ============================================================

export interface RerankerInsight {
  factor: string;
  weight: number;
}

export interface RerankerLearningResult {
  insights: RerankerInsight[];
}

/**
 * Learn which retrieval ranking factors correlate with successful answers.
 *
 * Heuristic: for each LearningObservation, look at whether the
 * verificationResult was positive (verified/supported) and whether
 * retrievedContextIds was non-empty. Then compute correlations with
 * evidenceQuality, sourceQuality, and confidence. Higher correlation →
 * higher factor weight.
 */
export async function learnReranker(tenantId: string): Promise<RerankerLearningResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return { insights: [] };

  const observations = await db.learningObservation.findMany({
    where: { tenantId },
    select: {
      verificationResult: true,
      evidenceQuality: true,
      sourceQuality: true,
      confidence: true,
      retrievedContextIds: true,
      userFeedback: true,
    },
    take: 500,
    orderBy: { createdAt: "desc" },
  });

  if (observations.length < 5) {
    return { insights: defaultRerankerWeights() };
  }

  // Factor weight = average of (positive_signal ? factor_value : 1 - factor_value)
  // across observations where we can derive a positive/negative signal.
  const factors: Record<string, { sum: number; count: number }> = {
    evidenceQuality: { sum: 0, count: 0 },
    sourceQuality: { sum: 0, count: 0 },
    confidence: { sum: 0, count: 0 },
    contextRichness: { sum: 0, count: 0 },
  };

  for (const o of observations) {
    const positive =
      o.verificationResult === "verified" ||
      o.verificationResult === "supported" ||
      o.userFeedback === "thumbs_up";
    const negative =
      o.verificationResult === "unsupported" ||
      o.verificationResult === "conflicted" ||
      o.userFeedback === "thumbs_down" ||
      o.userFeedback === "correction";
    if (!positive && !negative) continue;

    const signal = positive ? 1 : 0;

    if (o.evidenceQuality) {
      const v = mapQualityToValue(o.evidenceQuality);
      factors.evidenceQuality.sum += signal ? v : 1 - v;
      factors.evidenceQuality.count++;
    }
    if (o.sourceQuality !== null) {
      const v = clamp(o.sourceQuality);
      factors.sourceQuality.sum += signal ? v : 1 - v;
      factors.sourceQuality.count++;
    }
    if (o.confidence !== null) {
      const v = clamp(o.confidence);
      factors.confidence.sum += signal ? v : 1 - v;
      factors.confidence.count++;
    }
    const ctxIds = safeParse<string[]>(o.retrievedContextIds);
    if (ctxIds) {
      const v = clamp(ctxIds.length / 5); // saturate at 5 retrieved items
      factors.contextRichness.sum += signal ? v : 1 - v;
      factors.contextRichness.count++;
    }
  }

  const insights: RerankerInsight[] = [];
  for (const [factor, val] of Object.entries(factors)) {
    const weight = val.count > 0 ? clamp(val.sum / val.count) : 0.5;
    insights.push({ factor, weight: Math.round(weight * 100) / 100 });
  }

  await ZeroCostGovernor.record("learning_event");
  return { insights };
}

function defaultRerankerWeights(): RerankerInsight[] {
  return [
    { factor: "evidenceQuality", weight: 0.5 },
    { factor: "sourceQuality", weight: 0.5 },
    { factor: "confidence", weight: 0.5 },
    { factor: "contextRichness", weight: 0.5 },
  ];
}

function mapQualityToValue(q: string): number {
  const map: Record<string, number> = {
    verified: 1.0,
    supported: 0.85,
    inferred: 0.65,
    uncertain: 0.4,
    conflicted: 0.2,
    unsupported: 0.1,
    unknown: 0.5,
  };
  return map[q.toLowerCase()] ?? 0.5;
}

// ============================================================
// 13. Model Benchmark Engine
// ============================================================

export interface BenchmarkResult {
  results: Array<{
    modelId: string;
    taskType: string;
    accuracy: number;
    latencyMs: number;
  }>;
}

/**
 * Aggregate the latest ModelBenchmark rows into a per-(modelId, taskType)
 * summary. Does NOT trigger new benchmark runs (those are scheduled by the
 * evaluation batch Inngest function); this engine just reads + summarizes.
 *
 * accuracy = (factualAccuracy | reasoningAccuracy | synthesisQuality |
 *             codingQuality) chosen by taskType; defaults to 0.5 when no
 *             task-relevant metric is present.
 */
export async function benchmarkModels(): Promise<BenchmarkResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return { results: [] };

  const rows = await db.modelBenchmark.findMany({
    orderBy: { benchmarkDate: "desc" },
    take: 200,
  });

  // Keep only the latest row per (modelId, taskType).
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.modelId}::${r.taskType}`;
    if (!latest.has(key)) latest.set(key, r);
  }

  const results: BenchmarkResult["results"] = [];
  for (const r of latest.values()) {
    const accuracy = pickAccuracyForTask(r);
    const latencyMs = r.p50LatencyMs ?? r.avgLatencyMs ?? 0;
    results.push({
      modelId: r.modelId,
      taskType: r.taskType,
      accuracy: Math.round(accuracy * 1000) / 1000,
      latencyMs,
    });
  }

  await ZeroCostGovernor.record("learning_event");
  return { results };
}

function pickAccuracyForTask(r: {
  taskType: string;
  factualAccuracy: number | null;
  reasoningAccuracy: number | null;
  synthesisQuality: number | null;
  codingQuality: number | null;
}): number {
  switch (r.taskType) {
    case "factual":
      return r.factualAccuracy ?? 0.5;
    case "reasoning":
      return r.reasoningAccuracy ?? 0.5;
    case "synthesis":
      return r.synthesisQuality ?? 0.5;
    case "coding":
      return r.codingQuality ?? 0.5;
    default:
      return (
        r.factualAccuracy ??
        r.reasoningAccuracy ??
        r.synthesisQuality ??
        r.codingQuality ??
        0.5
      );
  }
}

// ============================================================
// 14. Release Gate
// ============================================================

export interface ReleaseGateInput {
  candidateReleaseId: string;
  activeReleaseId?: string;
}

export interface ReleaseGateResult {
  decision: "PASS" | "PASS_WITH_WARNINGS" | "BLOCKED" | "ROLLBACK";
  summary: string;
}

/**
 * Evaluate whether a candidate Brain release should be approved.
 *
 * PASS              — candidate pass rate >= 0.95 AND no regression vs active
 * PASS_WITH_WARNINGS — candidate pass rate >= 0.85 OR small regression (<5pp)
 * BLOCKED           — candidate pass rate < 0.85 OR >=5pp regression
 * ROLLBACK          — the ACTIVE release's pass rate dropped below 0.7 (the
 *                     active release itself has regressed and should be rolled
 *                     back to a prior version).
 *
 * The release gate NEVER auto-activates a release — it produces a decision
 * signal. A human (or a release-deploy Inngest function) must apply the
 * decision.
 */
export async function evaluateReleaseGate(
  opts: ReleaseGateInput,
): Promise<ReleaseGateResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    return {
      decision: "BLOCKED",
      summary: "governor denied learning_event — release gate deferred",
    };
  }

  const candidate = await db.brainRelease.findUnique({
    where: { id: opts.candidateReleaseId },
  });
  if (!candidate) {
    return { decision: "BLOCKED", summary: "candidate release not found" };
  }

  const candidateSummary = safeParse<{ passRate?: number; regression?: number; caseCount?: number }>(
    candidate.evaluationSummary,
  );
  const candidatePassRate = candidateSummary?.passRate ?? 0;

  let activePassRate: number | null = null;
  if (opts.activeReleaseId) {
    const active = await db.brainRelease.findUnique({
      where: { id: opts.activeReleaseId },
    });
    if (active) {
      const activeSummary = safeParse<{ passRate?: number }>(active.evaluationSummary);
      activePassRate = activeSummary?.passRate ?? null;
    }
  }

  let decision: ReleaseGateResult["decision"];
  let summary: string;

  if (activePassRate !== null && activePassRate < 0.7) {
    decision = "ROLLBACK";
    summary = `active release passRate=${activePassRate.toFixed(2)} < 0.70 — roll back to a prior version`;
  } else if (candidatePassRate >= 0.95) {
    const regression = activePassRate !== null ? activePassRate - candidatePassRate : 0;
    if (regression > 0.05) {
      decision = "BLOCKED";
      summary = `candidate passRate=${candidatePassRate.toFixed(2)} but regression ${(regression * 100).toFixed(1)}pp vs active`;
    } else {
      decision = "PASS";
      summary = `candidate passRate=${candidatePassRate.toFixed(2)} — no material regression`;
    }
  } else if (candidatePassRate >= 0.85) {
    const regression = activePassRate !== null ? activePassRate - candidatePassRate : 0;
    if (regression > 0.05) {
      decision = "BLOCKED";
      summary = `candidate passRate=${candidatePassRate.toFixed(2)} but regression ${(regression * 100).toFixed(1)}pp vs active`;
    } else {
      decision = "PASS_WITH_WARNINGS";
      summary = `candidate passRate=${candidatePassRate.toFixed(2)} — acceptable but monitor`;
    }
  } else {
    decision = "BLOCKED";
    summary = `candidate passRate=${candidatePassRate.toFixed(2)} < 0.85 — release blocked`;
  }

  await ZeroCostGovernor.record("learning_event");
  return { decision, summary };
}

// ============================================================
// 15. Learning Ledger
// ============================================================

export interface LedgerEntryInput {
  tenantId: string;
  entryType: string; // e.g. "candidate.scored", "candidate.promoted", "candidate.rejected", "release.gate"
  candidateId?: string;
  decision: string;
  reason: string;
  evidenceCount?: number;
  contradictionCheck?: string; // PASS | FAIL | SKIP
  sourceQuality?: number;
  policyVersion?: string;
  decidedBy?: string; // system | human | release-gate
  metadata?: Record<string, unknown>;
}

/**
 * Append an entry to the Learning Ledger (PromotionDecision table). The
 * ledger is append-only — entries are NEVER deleted or updated. Every
 * learning decision (score, validate, contradict, promote, reject, defer,
 * release-gate) should be audited here.
 */
export async function recordLedgerEntry(opts: LedgerEntryInput): Promise<void> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return;

  await db.promotionDecision.create({
    data: {
      tenantId: opts.tenantId,
      candidateType: "knowledge", // ledger entries default to knowledge candidates
      candidateId: opts.candidateId ?? "n/a",
      decision: opts.decision,
      reason: opts.reason,
      evidenceCount: opts.evidenceCount ?? 0,
      contradictionCheck: opts.contradictionCheck ?? "SKIP",
      sourceQuality: opts.sourceQuality ?? null,
      policyVersion: opts.policyVersion ?? POLICY_VERSION,
      decidedBy: opts.decidedBy ?? "system",
      metadata: JSON.stringify({
        entryType: opts.entryType,
        ...opts.metadata,
        recordedAt: new Date().toISOString(),
      }),
    },
  });
  await ZeroCostGovernor.record("learning_event");
}

// ============================================================
// Full promotion pipeline
// ============================================================

export interface PromotionPipelineResult {
  promoted: boolean;
  decision: string;
  reason: string;
  score?: number;
}

/**
 * Run the full candidate → approved flow.
 *
 * Pipeline:
 *   1. Score the candidate (LearningValue signal).
 *   2. Validate evidence (evidenceCount must be > 0 for promotion).
 *   3. Detect contradictions (must be zero unresolved for promotion).
 *   4. Decide:
 *        - PROMOTED → flip the underlying KnowledgeItem to ACTIVE
 *          (or create one if the candidate has no linked item yet)
 *          + record ledger entry.
 *        - REJECTED → record ledger entry, do not mutate knowledge.
 *        - DEFERRED → record ledger entry, candidate stays PENDING.
 *        - QUARANTINED → contradictions unresolved; record ledger entry,
 *          candidate marked DEFERRED with explicit contradiction note.
 *
 * NEVER auto-promotes. Only PROMOTED decisions change status to ACTIVE,
 * and ONLY when evidenceCount > 0 AND no unresolved contradictions.
 */
export async function runPromotionPipeline(
  candidateId: string,
): Promise<PromotionPipelineResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    return {
      promoted: false,
      decision: "DEFERRED",
      reason: `governor denied learning_event: ${gate.reason ?? "unknown"}`,
    };
  }

  const candidate = await db.learningCandidate.findUnique({
    where: { id: candidateId },
  });
  if (!candidate) {
    return {
      promoted: false,
      decision: "REJECTED",
      reason: "candidate not found",
    };
  }

  // 1. Score.
  const score = await scoreCandidate(candidateId);

  // 2. Validate evidence.
  const evidence = await validateEvidence(candidateId);

  // 3. Detect contradictions.
  const contradictions = await detectContradictions(candidateId);

  // Ledger entry: scored.
  await recordLedgerEntry({
    tenantId: candidate.tenantId,
    entryType: "candidate.scored",
    candidateId,
    decision: "SCORED",
    reason: score.recommendation,
    evidenceCount: evidence.evidenceCount,
    contradictionCheck: contradictions.hasContradiction ? "FAIL" : "PASS",
    sourceQuality: score.factors.sourceQuality ?? undefined,
    decidedBy: "system",
    metadata: { score: score.score, factors: score.factors },
  });

  // 4. Decide.
  const proposed = safeParse<Record<string, unknown>>(candidate.proposed) ?? {};

  // QUARANTINE: contradictions unresolved.
  if (contradictions.hasContradiction) {
    await db.learningCandidate.update({
      where: { id: candidateId },
      data: {
        decision: "DEFERRED",
        decisionReason: `Quarantined: ${contradictions.conflicts.length} unresolved contradiction(s)`,
        conflictDetected: true,
        decidedAt: new Date(),
      },
    });
    await recordLedgerEntry({
      tenantId: candidate.tenantId,
      entryType: "candidate.quarantined",
      candidateId,
      decision: "QUARANTINED",
      reason: `Contradictions with existing items: ${contradictions.conflicts
        .map((c) => c.existingId)
        .join(", ")}`,
      evidenceCount: evidence.evidenceCount,
      contradictionCheck: "FAIL",
      decidedBy: "system",
    });
    return {
      promoted: false,
      decision: "QUARANTINED",
      reason: `unresolved contradictions: ${contradictions.conflicts.length}`,
      score: score.score,
    };
  }

  // DEFER: no evidence yet.
  if (evidence.evidenceCount === 0) {
    await db.learningCandidate.update({
      where: { id: candidateId },
      data: {
        decision: "DEFERRED",
        decisionReason: "No supporting evidence — awaiting Evidence Collector",
        decidedAt: new Date(),
      },
    });
    await recordLedgerEntry({
      tenantId: candidate.tenantId,
      entryType: "candidate.deferred",
      candidateId,
      decision: "DEFERRED",
      reason: "No supporting evidence yet",
      evidenceCount: 0,
      contradictionCheck: "PASS",
      decidedBy: "system",
    });
    return {
      promoted: false,
      decision: "DEFERRED",
      reason: "no supporting evidence yet",
      score: score.score,
    };
  }

  // REJECT: low score.
  if (score.score < 0.3) {
    await db.learningCandidate.update({
      where: { id: candidateId },
      data: {
        decision: "REJECTED",
        decisionReason: `Low LearningValue score: ${score.score.toFixed(2)}`,
        decidedAt: new Date(),
      },
    });
    await recordLedgerEntry({
      tenantId: candidate.tenantId,
      entryType: "candidate.rejected",
      candidateId,
      decision: "REJECTED",
      reason: `Low LearningValue score: ${score.score.toFixed(2)}`,
      evidenceCount: evidence.evidenceCount,
      contradictionCheck: "PASS",
      decidedBy: "system",
    });
    return {
      promoted: false,
      decision: "REJECTED",
      reason: `low LearningValue score: ${score.score.toFixed(2)}`,
      score: score.score,
    };
  }

  // DEFER: borderline score (0.3 ≤ score < 0.7).
  if (score.score < 0.7) {
    await db.learningCandidate.update({
      where: { id: candidateId },
      data: {
        decision: "DEFERRED",
        decisionReason: `Borderline score: ${score.score.toFixed(2)} — gather more evidence`,
        decidedAt: new Date(),
      },
    });
    await recordLedgerEntry({
      tenantId: candidate.tenantId,
      entryType: "candidate.deferred",
      candidateId,
      decision: "DEFERRED",
      reason: `Borderline LearningValue score: ${score.score.toFixed(2)}`,
      evidenceCount: evidence.evidenceCount,
      contradictionCheck: "PASS",
      decidedBy: "system",
    });
    return {
      promoted: false,
      decision: "DEFERRED",
      reason: `borderline score: ${score.score.toFixed(2)}`,
      score: score.score,
    };
  }

  // PROMOTE: score >= 0.7, evidence > 0, no contradictions.
  // Materialize the candidate into a KnowledgeItem with status=ACTIVE.
  const tenantId = candidate.tenantId;
  const applicationId =
    typeof proposed.applicationId === "string" ? proposed.applicationId : "";
  if (!applicationId) {
    await db.learningCandidate.update({
      where: { id: candidateId },
      data: {
        decision: "DEFERRED",
        decisionReason: "Promotion blocked: missing applicationId in proposed payload",
        decidedAt: new Date(),
      },
    });
    await recordLedgerEntry({
      tenantId,
      entryType: "candidate.deferred",
      candidateId,
      decision: "DEFERRED",
      reason: "Missing applicationId in proposed payload",
      evidenceCount: evidence.evidenceCount,
      contradictionCheck: "PASS",
      decidedBy: "system",
    });
    return {
      promoted: false,
      decision: "DEFERRED",
      reason: "missing applicationId in proposed payload",
      score: score.score,
    };
  }

  const claim = typeof proposed.claim === "string" ? proposed.claim : "";
  const content = typeof proposed.content === "string" ? proposed.content : "";
  const type = typeof proposed.type === "string" ? proposed.type : "FACT";
  const scope = typeof proposed.scope === "string" ? proposed.scope : "APPLICATION";
  const sourceQuality =
    typeof proposed.sourceQuality === "number" ? proposed.sourceQuality : 0.5;
  const provenance =
    typeof proposed.provenance === "object" && proposed.provenance !== null
      ? (proposed.provenance as Record<string, unknown>)
      : null;

  // Create the KnowledgeItem with status=ACTIVE.
  const newItem = await db.knowledgeItem.create({
    data: {
      tenantId,
      applicationId,
      type,
      scope,
      claim,
      content,
      status: "ACTIVE",
      confidence: score.score,
      validFrom: new Date(),
      refreshSchedule: "manual",
      lastRefreshedAt: new Date(),
    },
  });

  // Optionally link a KnowledgeSource from provenance (best-effort).
  if (provenance && typeof provenance.sourceApp === "string") {
    const source = await db.knowledgeSource.findFirst({
      where: { tenantId, title: provenance.sourceApp as string },
    });
    if (source) {
      await db.knowledgeItem.update({
        where: { id: newItem.id },
        data: { sourceId: source.id },
      });
    }
  }

  // Update candidate to PROMOTED.
  await db.learningCandidate.update({
    where: { id: candidateId },
    data: {
      decision: "PROMOTED",
      decisionReason: `Promoted: score=${score.score.toFixed(2)}, evidence=${evidence.evidenceCount}, no contradictions`,
      decidedAt: new Date(),
    },
  });

  // Audit the promotion (AuditEvent — spec §129).
  await db.auditEvent.create({
    data: {
      tenantId,
      actorType: "system",
      actorId: "brain.learning-fabric",
      action: "knowledge.promote",
      target: newItem.id,
      reason: `Promoted via runPromotionPipeline (candidate=${candidateId})`,
      metadata: JSON.stringify({
        candidateId,
        knowledgeItemId: newItem.id,
        score: score.score,
        evidenceCount: evidence.evidenceCount,
      }),
      severity: "INFO",
    },
  });

  // Record the promotion in the ledger.
  await recordLedgerEntry({
    tenantId,
    entryType: "candidate.promoted",
    candidateId,
    decision: "PROMOTED",
    reason: `Promoted to KnowledgeItem ${newItem.id}`,
    evidenceCount: evidence.evidenceCount,
    contradictionCheck: "PASS",
    sourceQuality,
    decidedBy: "system",
    metadata: { knowledgeItemId: newItem.id, score: score.score },
  });

  return {
    promoted: true,
    decision: "PROMOTED",
    reason: `promoted to KnowledgeItem ${newItem.id}`,
    score: score.score,
  };
}

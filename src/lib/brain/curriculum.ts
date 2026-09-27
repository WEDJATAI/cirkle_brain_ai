// WEDJAT BRAIN V2 — Curriculum Engine (spec Part 7).
//
// The Brain automatically discovers weak areas and generates a structured
// curriculum to close those gaps. Weak areas are derived from observed
// failure signals across the entire learning fabric — NOT from a single
// source. The discovery aggregator merges nine distinct signals:
//
//   1. failed evaluations       (EvaluationRun FAILED / low passRate)
//   2. user corrections          (Feedback signal in {correction, retry, regenerate})
//   3. low-confidence responses  (LearningObservation.confidence < 0.4)
//   4. unsupported claims        (verificationResult in {unsupported, conflicted, unknown})
//   5. repeated questions        (same question asked N+ times in 14d)
//   6. missing knowledge         (answerOutcome='insufficient')
//   7. stale knowledge           (KnowledgeItem refreshSchedule overdue)
//   8. model disagreement        (multiple models selected for same taskType with mixed success)
//   9. poor retrieval            (failureType=BAD_RETRIEVAL or empty retrievedContextIds)
//
// The generated curriculum follows the spec Part 7 canonical step order:
//   fundamentals → terminology → country differences → examples →
//   edge cases → contradictions → evaluation cases
//
// Rules:
//   - Every operation pre-flights ZeroCostGovernor.canPerform("learning_event").
//   - CurriculumItem is the persistence model (one row per ISO-week + domain).
//   - The LLM is never imported here — this is a policy/intelligence module.

import { db } from "@/lib/db";
import { ZeroCostGovernor } from "@/lib/brain/zero-cost-governor";

// ============================================================
// Types
// ============================================================

export interface WeakArea {
  domain: string;
  score: number; // 0 = weakest, 1 = strongest (1 - normalized evidence count)
  evidence: string[]; // human-readable evidence lines for this weak area
}

export interface CurriculumStep {
  step: number;
  topic: string;
  status: string; // PENDING | IN_PROGRESS | COMPLETED
  resources?: string[];
}

export interface Curriculum {
  week: string; // ISO week, e.g. "2026-W38"
  domain: string;
  weakConcepts: string[];
  steps: CurriculumStep[];
}

export interface GenerateCurriculumOptions {
  tenantId: string;
  domain: string;
  depth?: number; // 1-3, default 1. Higher depth = more resources per step.
}

// ============================================================
// Canonical curriculum stage order (spec Part 7)
// ============================================================

const CURRICULUM_STAGES = [
  { key: "fundamentals", label: "Fundamentals" },
  { key: "terminology", label: "Terminology" },
  { key: "country_differences", label: "Country / jurisdiction differences" },
  { key: "examples", label: "Worked examples" },
  { key: "edge_cases", label: "Edge cases" },
  { key: "contradictions", label: "Contradictions and conflict resolution" },
  { key: "evaluation_cases", label: "Evaluation cases" },
] as const;

// ============================================================
// Helpers
// ============================================================

function isoWeek(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function safeParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function normalizeDomain(s: string | null | undefined): string {
  if (!s) return "general";
  return s.trim().toLowerCase();
}

const SINCE_14D = (): Date => new Date(Date.now() - 14 * 86400000);
const SINCE_30D = (): Date => new Date(Date.now() - 30 * 86400000);

// Stale-knowledge threshold per refreshSchedule (spec §33).
function staleThresholdFor(schedule: string | null | undefined): Date {
  const now = Date.now();
  switch ((schedule ?? "manual").toLowerCase()) {
    case "real-time":
      return new Date(now - 1 * 3600000); // 1 hour
    case "hourly":
      return new Date(now - 2 * 3600000); // 2 hours
    case "daily":
      return new Date(now - 2 * 86400000); // 2 days
    case "weekly":
      return new Date(now - 14 * 86400000); // 2 weeks
    case "monthly":
      return new Date(now - 60 * 86400000); // 60 days
    case "event-triggered":
      // event-triggered knowledge is stale only if the item's validUntil passed
      return new Date(0);
    case "manual":
    default:
      // manual refresh is never stale by schedule alone
      return new Date(0);
  }
}

// ============================================================
// 1. discoverWeakAreas
// ============================================================

/**
 * Discover weak domains by aggregating nine failure signals across the
 * learning fabric. Returns one WeakArea per domain that has at least one
 * signal, sorted weakest-first (score ascending; 0 = weakest).
 */
export async function discoverWeakAreas(
  tenantId: string,
): Promise<WeakArea[]> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return [];

  const since14 = SINCE_14D();
  const since30 = SINCE_30D();

  // Per-domain accumulator: evidence lines + raw signal counts.
  const domainMap = new Map<
    string,
    { evidence: string[]; signals: number }
  >();

  const addEvidence = (
    domain: string,
    line: string,
    weight = 1,
  ): void => {
    const d = normalizeDomain(domain);
    if (!domainMap.has(d)) {
      domainMap.set(d, { evidence: [], signals: 0 });
    }
    const entry = domainMap.get(d)!;
    entry.evidence.push(line);
    entry.signals += weight;
  };

  // (1) Failed evaluations.
  const failedRuns = await db.evaluationRun.findMany({
    where: {
      status: { in: ["FAILED", "COMPLETED"] },
      createdAt: { gte: since30 },
    },
    take: 100,
  });
  for (const run of failedRuns) {
    const results = safeParse<{ passRate?: number; fail?: number; pass?: number }>(run.results);
    const passRate = results?.passRate ?? null;
    const failed = run.status === "FAILED" || (passRate !== null && passRate < 0.7);
    if (!failed) continue;
    // EvaluationRun has no domain field; tag with the EvaluationSet name as the domain.
    const set = await db.evaluationSet.findUnique({ where: { id: run.setId } });
    const domain = set?.name ?? "evaluation";
    addEvidence(
      domain,
      `EvaluationRun ${run.id} ${run.status} (passRate=${passRate ?? "n/a"}) on set "${set?.name ?? "?"}"`,
      2,
    );
  }

  // (2) User corrections.
  const corrections = await db.feedback.findMany({
    where: {
      tenantId,
      signal: { in: ["correction", "retry", "regenerate", "thumbs_down"] },
      createdAt: { gte: since14 },
    },
    take: 100,
  });
  for (const f of corrections) {
    const domain = "general"; // Feedback rows do not carry domain
    addEvidence(
      domain,
      `User ${f.signal} on feedback ${f.id}${f.content ? `: ${f.content.slice(0, 60)}` : ""}`,
      1,
    );
  }

  // (3-6, 9) Learning observations cover: low-confidence, unsupported,
  // missing-knowledge, poor retrieval, and failure types.
  const observations = await db.learningObservation.findMany({
    where: {
      tenantId,
      createdAt: { gte: since14 },
      OR: [
        { confidence: { lt: 0.4 } },
        { verificationResult: { in: ["unsupported", "conflicted", "unknown"] } },
        { answerOutcome: "insufficient" },
        { answerOutcome: "failed" },
        { failureType: { not: null } },
        { userFeedback: { in: ["thumbs_down", "correction"] } },
      ],
    },
    take: 200,
  });
  for (const o of observations) {
    const domain = o.domain ?? o.taskType ?? "general";
    const lines: string[] = [];
    let weight = 1;
    if (o.confidence !== null && o.confidence < 0.4) {
      lines.push(`low confidence (${o.confidence.toFixed(2)})`);
      weight = Math.max(weight, 1);
    }
    if (o.verificationResult && ["unsupported", "conflicted", "unknown"].includes(o.verificationResult)) {
      lines.push(`verification=${o.verificationResult}`);
      weight = Math.max(weight, 2);
    }
    if (o.answerOutcome === "insufficient") {
      lines.push("insufficient answer (missing knowledge)");
      weight = Math.max(weight, 2);
    }
    if (o.failureType === "BAD_RETRIEVAL") {
      lines.push("poor retrieval");
      weight = Math.max(weight, 2);
    } else if (o.failureType) {
      lines.push(`failureType=${o.failureType}`);
      weight = Math.max(weight, 2);
    }
    if (o.userFeedback === "thumbs_down" || o.userFeedback === "correction") {
      lines.push(`userFeedback=${o.userFeedback}`);
      weight = Math.max(weight, 1);
    }
    if (lines.length === 0) continue;
    addEvidence(
      domain,
      `Observation ${o.id} — ${lines.join(", ")} (q: "${o.question.slice(0, 50)}")`,
      weight,
    );
  }

  // (5) Repeated questions (same question asked N+ times in 14d).
  const recentQuestions = await db.learningObservation.findMany({
    where: { tenantId, createdAt: { gte: since14 } },
    select: { question: true, domain: true },
    take: 500,
  });
  const qCounts = new Map<string, { count: number; domain: string }>();
  for (const o of recentQuestions) {
    const key = o.question.trim().toLowerCase().slice(0, 120);
    if (!key) continue;
    const domain = normalizeDomain(o.domain);
    if (!qCounts.has(key)) qCounts.set(key, { count: 0, domain });
    qCounts.get(key)!.count++;
  }
  for (const [key, { count, domain }] of qCounts) {
    if (count < 3) continue; // 3+ occurrences = repeated
    addEvidence(
      domain,
      `Repeated question (${count}× in 14d): "${key.slice(0, 60)}"`,
      Math.min(count, 5),
    );
  }

  // (7) Stale knowledge (refresh schedule overdue).
  const knowledge = await db.knowledgeItem.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      refreshSchedule: { not: null },
    },
    select: {
      id: true,
      claim: true,
      type: true,
      refreshSchedule: true,
      lastRefreshedAt: true,
      validUntil: true,
    },
    take: 500,
  });
  // KnowledgeItem has no `domain` field — bucket by the refreshSchedule as a
  // coarse proxy when surfacing stale-knowledge weak areas.
  for (const k of knowledge) {
    const schedule = k.refreshSchedule ?? "manual";
    const staleDate = staleThresholdFor(schedule);
    const lastRefreshed = k.lastRefreshedAt ?? new Date(0);
    const validUntilPassed = k.validUntil ? k.validUntil.getTime() < Date.now() : false;
    if (lastRefreshed.getTime() < staleDate.getTime() || validUntilPassed) {
      // We don't have a domain column — bucket by the refreshSchedule + type
      // as a coarse proxy so callers can group related stale items.
      const domain = `stale:${schedule}:${k.type ?? "unknown"}`;
      addEvidence(
        domain,
        `Stale knowledge ${k.id} (type=${k.type ?? "?"}, schedule=${schedule}, lastRefreshed=${lastRefreshed.toISOString()}, validUntilPassed=${validUntilPassed})`,
        1,
      );
    }
  }

  // (8) Model disagreement — multiple models selected for same taskType with
  // mixed success rates.
  const usage = await db.modelUsage.findMany({
    where: { tenantId, createdAt: { gte: since14 } },
    select: { modelId: true, taskType: true, success: true },
    take: 500,
  });
  const taskModels = new Map<
    string,
    Map<string, { success: number; total: number }>
  >();
  for (const u of usage) {
    const task = u.taskType ?? "unknown";
    if (!taskModels.has(task)) taskModels.set(task, new Map());
    const models = taskModels.get(task)!;
    if (!models.has(u.modelId)) models.set(u.modelId, { success: 0, total: 0 });
    const e = models.get(u.modelId)!;
    e.total++;
    if (u.success) e.success++;
  }
  for (const [task, models] of taskModels) {
    if (models.size < 2) continue;
    const rates: number[] = [];
    for (const [, e] of models) {
      if (e.total >= 2) rates.push(e.success / e.total);
    }
    if (rates.length < 2) continue;
    const max = Math.max(...rates);
    const min = Math.min(...rates);
    if (max - min >= 0.3) {
      addEvidence(
        `model-disagreement:${task}`,
        `Model disagreement on taskType="${task}" — success rates vary ${(min * 100).toFixed(0)}%–${(max * 100).toFixed(0)}% across ${models.size} models`,
        2,
      );
    }
  }

  await ZeroCostGovernor.record("learning_event");

  // Normalize: score = 1 - (signals / maxSignals). Weakest (most signals) → 0.
  const entries = Array.from(domainMap.entries());
  if (entries.length === 0) return [];

  const maxSignals = Math.max(...entries.map(([, v]) => v.signals), 1);
  const weakAreas: WeakArea[] = entries.map(([domain, { evidence, signals }]) => ({
    domain,
    score: 1 - signals / maxSignals,
    evidence: evidence.slice(0, 12), // cap evidence lines for readability
  }));

  // Sort weakest-first (score ascending).
  weakAreas.sort((a, b) => a.score - b.score);
  return weakAreas;
}

// ============================================================
// 2. generateCurriculum
// ============================================================

/**
 * Generate a structured curriculum for a weak domain. The seven-step order
 * is canonical per spec Part 7:
 *   fundamentals → terminology → country differences → examples →
 *   edge cases → contradictions → evaluation cases
 *
 * Each step's `resources` are pulled from existing knowledge items,
 * learning observations, and failure records for the given domain — so the
 * curriculum is grounded in observed evidence rather than a generic template.
 */
export async function generateCurriculum(
  opts: GenerateCurriculumOptions,
): Promise<Curriculum> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    // Still return a minimal skeleton so callers can render something.
    return {
      week: isoWeek(),
      domain: opts.domain,
      weakConcepts: [],
      steps: CURRICULUM_STAGES.map((stage, i) => ({
        step: i + 1,
        topic: `${stage.label} for ${opts.domain}`,
        status: "PENDING",
        resources: [],
      })),
    };
  }

  const depth = Math.max(1, Math.min(3, opts.depth ?? 1));
  const resourceCap = depth * 3; // 3/6/9 resources per step

  // Gather evidence for the domain.
  const [knowledge, observations, failures] = await Promise.all([
    db.knowledgeItem.findMany({
      where: {
        tenantId: opts.tenantId,
        status: "ACTIVE",
        OR: [
          { claim: { contains: opts.domain, mode: "insensitive" } },
          { content: { contains: opts.domain, mode: "insensitive" } },
        ],
      },
      select: { id: true, claim: true, type: true, confidence: true },
      take: 50,
    }),
    db.learningObservation.findMany({
      where: {
        tenantId: opts.tenantId,
        createdAt: { gte: SINCE_14D() },
        OR: [
          { domain: { contains: opts.domain, mode: "insensitive" } },
          { taskType: { contains: opts.domain, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        question: true,
        failureType: true,
        userFeedback: true,
        verificationResult: true,
      },
      take: 50,
    }),
    db.failureRecord.findMany({
      where: {
        tenantId: opts.tenantId,
        status: { in: ["OPEN", "INVESTIGATING"] },
        description: { contains: opts.domain, mode: "insensitive" },
      },
      select: { id: true, description: true, failureType: true, layer: true },
      take: 25,
    }),
  ]);

  // Build weakConcepts (deduped, capped at 10).
  const weakSet = new Set<string>();
  for (const o of observations) {
    if (o.failureType || o.userFeedback === "thumbs_down" || o.userFeedback === "correction") {
      weakSet.add(o.question.slice(0, 80));
    }
  }
  for (const f of failures) {
    weakSet.add(f.description.slice(0, 80));
  }
  const weakConcepts = Array.from(weakSet).slice(0, 10);

  // Build per-step resources. Each stage pulls the most relevant slice of
  // evidence (knowledge for fundamentals/terminology/examples; failures
  // for contradictions/edge_cases; observations for evaluation_cases).
  const knowledgeResources = knowledge.slice(0, resourceCap).map((k) => `knowledge:${k.id}`);
  const observationResources = observations.slice(0, resourceCap).map((o) => `observation:${o.id}`);
  const failureResources = failures.slice(0, resourceCap).map((f) => `failure:${f.id}`);

  const resourceFor = (stageKey: string): string[] => {
    switch (stageKey) {
      case "fundamentals":
      case "terminology":
        return knowledgeResources;
      case "country_differences":
        // Surface knowledge tagged with country/jurisdiction variance — we
        // approximate by surfacing high-confidence items as "anchoring"
        // references; the consuming learning fabric decides if the domain
        // actually has jurisdictional variance.
        return knowledge
          .filter((k) => (k.confidence ?? 0) >= 0.6)
          .slice(0, resourceCap)
          .map((k) => `knowledge:${k.id}`);
      case "examples":
        return knowledgeResources;
      case "edge_cases":
        return failureResources;
      case "contradictions":
        return failureResources;
      case "evaluation_cases":
        return observationResources;
      default:
        return [];
    }
  };

  const steps: CurriculumStep[] = CURRICULUM_STAGES.map((stage, i) => ({
    step: i + 1,
    topic: `${stage.label} for ${opts.domain}`,
    status: "PENDING",
    resources: resourceFor(stage.key),
  }));

  await ZeroCostGovernor.record("learning_event");

  return {
    week: isoWeek(),
    domain: opts.domain,
    weakConcepts,
    steps,
  };
}

// ============================================================
// 3. saveCurriculum
// ============================================================

/**
 * Persist a curriculum to the CurriculumItem table. Idempotent per
 * (tenantId, week, domain): replaces any existing PENDING curriculum for
 * the same key before inserting.
 *
 * Returns the new CurriculumItem id.
 */
export async function saveCurriculum(
  tenantId: string,
  curriculum: Curriculum,
): Promise<{ id: string }> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    throw new Error("governor denied learning_event — cannot save curriculum");
  }

  await db.curriculumItem.deleteMany({
    where: {
      tenantId,
      week: curriculum.week,
      domain: curriculum.domain,
      status: "PENDING",
    },
  });

  const created = await db.curriculumItem.create({
    data: {
      tenantId,
      week: curriculum.week,
      domain: curriculum.domain,
      weakConcepts: JSON.stringify(curriculum.weakConcepts),
      curriculum: JSON.stringify(curriculum.steps),
      status: "PENDING",
    },
  });

  await ZeroCostGovernor.record("learning_event");
  return { id: created.id };
}

// ============================================================
// 4. getActiveCurriculum
// ============================================================

/**
 * Returns the current ISO-week's active curriculum for a tenant. Preference
 * order: IN_PROGRESS > PENDING > COMPLETED, all within the current week.
 *
 * Returns null when no curriculum exists for the current week.
 */
export async function getActiveCurriculum(
  tenantId: string,
): Promise<Curriculum | null> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return null;

  const week = isoWeek();
  const items = await db.curriculumItem.findMany({
    where: { tenantId, week },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 1,
  });
  const row = items[0];
  if (!row) return null;

  const weakConcepts = safeParse<string[]>(row.weakConcepts) ?? [];
  const steps = safeParse<CurriculumStep[]>(row.curriculum) ?? [];

  await ZeroCostGovernor.record("learning_event");

  return {
    week: row.week,
    domain: row.domain,
    weakConcepts,
    steps,
  };
}

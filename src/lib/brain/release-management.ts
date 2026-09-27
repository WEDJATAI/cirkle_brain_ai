// WEDJAT BRAIN V2 — Release Management (spec Part 18).
//
// Treats Brain behavior as versioned releases. Every meaningful change to
// Brain state (knowledge, memory policy, router, reranker, prompts, tool
// policy, evaluation config) is captured as a candidate release, evaluated
// against the evaluation baseline, and only activated if it passes.
//
// Status flow (spec Part 18):
//   CANDIDATE → TESTING → APPROVED → ACTIVE → (ROLLBACK → previous ACTIVE)
//
// Hard rules:
//   - Only APPROVED releases can become ACTIVE.
//   - Only ONE release may be ACTIVE at any time. Activating a new release
//     demotes the previous ACTIVE release to ROLLED_BACK.
//   - rollbackRelease() flips the current ACTIVE → ROLLED_BACK and the
//     target (must be APPROVED) → ACTIVE.
//   - evaluateRelease() runs the evaluation suite against a candidate and
//     stores the summary. PASS / PASS_WITH_WARNINGS → eligible for APPROVED.
//     BLOCKED → cannot be approved.
//   - Every status transition writes an AuditEvent so the release history
//     is fully auditable.
//
// Rules:
//   - Every operation pre-flights ZeroCostGovernor.canPerform("learning_event").
//   - The LLM is never imported here — evaluation reuses existing
//     EvaluationRun results, never triggers new model calls itself.
//   - Uses the existing BrainRelease Prisma model (releaseId unique).

import { db } from "@/lib/db";
import { ZeroCostGovernor } from "@/lib/brain/zero-cost-governor";

// ============================================================
// Types
// ============================================================

export type ReleaseStatus =
  | "CANDIDATE"
  | "TESTING"
  | "APPROVED"
  | "ACTIVE"
  | "ROLLED_BACK";

export type ReleaseDecision = "PASS" | "PASS_WITH_WARNINGS" | "BLOCKED";

export interface CreateCandidateReleaseOptions {
  createdBy?: string;
  notes?: string;
}

export interface CreateCandidateReleaseResult {
  releaseId: string; // BrainRelease.id
}

export interface EvaluateReleaseResult {
  decision: ReleaseDecision;
  passRate: number; // 0..1
  regressionRate: number; // 0..1 (positive = regression vs active)
  summary: string;
}

export interface ListReleasesOptions {
  limit?: number;
}

// ============================================================
// Constants — versioning snapshots + thresholds
// ============================================================

const POLICY_VERSION = "2024.1";
const ROUTER_VERSION = "v1";
const RERANKER_VERSION = "v1";
const EVALUATION_VERSION = "v1";
const PROMPT_VERSION = "v1";
const TOOL_POLICY_VERSION = "v1";
const MEMORY_POLICY_VERSION = "v1";

const PASS_THRESHOLD = 0.95; // PASS
const WARN_THRESHOLD = 0.85; // PASS_WITH_WARNINGS (>= 0.85 and < 0.95)
const REGRESSION_THRESHOLD = 0.05; // >5pp regression blocks approval

// ============================================================
// Helpers
// ============================================================

function safeParse<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function generateReleaseId(): string {
  // Human-readable, sortable, unique. Format: rel-YYYYMMDD-<6 random>.
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `rel-${yyyy}${mm}${dd}-${rand}`;
}

async function writeAuditEvent(opts: {
  tenantId: string;
  actorType: string;
  actorId: string;
  action: string;
  target?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  severity?: "INFO" | "WARN" | "ERROR" | "CRITICAL";
}): Promise<void> {
  await db.auditEvent.create({
    data: {
      tenantId: opts.tenantId,
      actorType: opts.actorType,
      actorId: opts.actorId,
      action: opts.action,
      target: opts.target ?? null,
      reason: opts.reason ?? null,
      metadata: JSON.stringify(opts.metadata ?? {}),
      severity: opts.severity ?? "INFO",
    },
  });
}

/**
 * Resolve the tenantId for a release. BrainRelease is global (no tenantId
 * column) but AuditEvent requires one. We use the first ACTIVE tenant as
 * the owning tenant for audit purposes — this is consistent with the
 * single-tenant deployment posture documented in the worklog (Task 0).
 */
async function resolveAuditTenant(): Promise<string> {
  const tenant = await db.tenant.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return tenant?.id ?? "system";
}

// ============================================================
// 1. createCandidateRelease
// ============================================================

/**
 * Snapshot the current Brain state into a new CANDIDATE release. The snapshot
 * captures:
 *   - knowledge count + a deterministic hash of all ACTIVE KnowledgeItem ids
 *   - all version strings (memory policy, router, reranker, evaluation,
 *     prompt, tool policy)
 *
 * The release is created in CANDIDATE status and is NOT yet evaluated.
 */
export async function createCandidateRelease(
  opts: CreateCandidateReleaseOptions = {},
): Promise<CreateCandidateReleaseResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    throw new Error(
      `governor denied learning_event — cannot create candidate release: ${gate.reason ?? "unknown"}`,
    );
  }

  // Snapshot knowledge state.
  const activeKnowledge = await db.knowledgeItem.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, claim: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const knowledgeCount = activeKnowledge.length;
  // Deterministic hash of (id|updatedAt) — changes if any item was added,
  // removed, or updated.
  const knowledgeHash = await sha256Short(
    activeKnowledge.map((k) => `${k.id}@${k.updatedAt.toISOString()}`).join("|"),
  );

  const releaseId = generateReleaseId();
  const created = await db.brainRelease.create({
    data: {
      releaseId,
      knowledgeSnapshot: JSON.stringify({
        count: knowledgeCount,
        hash: knowledgeHash,
        sampledAt: new Date().toISOString(),
      }),
      memoryPolicyVersion: MEMORY_POLICY_VERSION,
      routerVersion: ROUTER_VERSION,
      rerankerVersion: RERANKER_VERSION,
      evaluationVersion: EVALUATION_VERSION,
      promptVersion: PROMPT_VERSION,
      toolPolicyVersion: TOOL_POLICY_VERSION,
      status: "CANDIDATE",
      createdBy: opts.createdBy ?? "system",
    },
  });

  const tenantId = await resolveAuditTenant();
  await writeAuditEvent({
    tenantId,
    actorType: "system",
    actorId: opts.createdBy ?? "system",
    action: "release.candidate.created",
    target: created.id,
    reason: opts.notes ?? "candidate release snapshot created",
    metadata: {
      releaseId,
      knowledgeCount,
      knowledgeHash,
      policyVersion: POLICY_VERSION,
    },
  });

  await ZeroCostGovernor.record("learning_event");
  return { releaseId: created.id };
}

// ============================================================
// 2. evaluateRelease
// ============================================================

/**
 * Evaluate a CANDIDATE release against the evaluation baseline. The
 * evaluation reuses existing EvaluationRun results (it never triggers new
 * model calls — that would consume model_call budget and risk SAFE_MODE).
 *
 * Decision matrix (mirrors learning-fabric.evaluateReleaseGate):
 *   PASS              — passRate >= 0.95 AND regression <= 5pp
 *   PASS_WITH_WARNINGS — passRate >= 0.85 AND regression <= 5pp
 *   BLOCKED           — passRate < 0.85 OR regression > 5pp
 *
 * On PASS or PASS_WITH_WARNINGS, the release transitions to TESTING status
 * (it must still be explicitly approved before activation).
 */
export async function evaluateRelease(
  releaseId: string,
): Promise<EvaluateReleaseResult> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    return {
      decision: "BLOCKED",
      passRate: 0,
      regressionRate: 0,
      summary: `governor denied learning_event: ${gate.reason ?? "unknown"}`,
    };
  }

  const release = await db.brainRelease.findUnique({
    where: { id: releaseId },
  });
  if (!release) {
    return {
      decision: "BLOCKED",
      passRate: 0,
      regressionRate: 0,
      summary: "release not found",
    };
  }
  if (release.status !== "CANDIDATE" && release.status !== "TESTING") {
    return {
      decision: "BLOCKED",
      passRate: 0,
      regressionRate: 0,
      summary: `release is in status ${release.status} — only CANDIDATE/TESTING releases can be evaluated`,
    };
  }

  // Aggregate the latest COMPLETED EvaluationRun per set.
  const sets = await db.evaluationSet.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  const setIds = sets.map((s) => s.id);

  let passRate = 0;
  let caseCount = 0;
  if (setIds.length > 0) {
    const runs = await db.evaluationRun.findMany({
      where: {
        setId: { in: setIds },
        status: "COMPLETED",
      },
      orderBy: { completedAt: "desc" },
    });
    // Keep only the latest run per setId.
    const latestBySet = new Map<string, { results: string | null }>();
    for (const r of runs) {
      if (!latestBySet.has(r.setId)) {
        latestBySet.set(r.setId, { results: r.results });
      }
    }
    let totalPass = 0;
    let totalCases = 0;
    for (const [, { results }] of latestBySet) {
      const parsed = safeParse<{ pass?: number; fail?: number; passRate?: number }>(results);
      const pass = parsed?.pass ?? 0;
      const fail = parsed?.fail ?? 0;
      const total = pass + fail;
      if (total > 0) {
        totalPass += pass;
        totalCases += total;
      } else if (typeof parsed?.passRate === "number") {
        // Fallback: use stored passRate if present.
        totalPass += Math.round(parsed.passRate * 100);
        totalCases += 100;
      }
    }
    if (totalCases > 0) {
      passRate = totalPass / totalCases;
      caseCount = totalCases;
    }
  }

  // Regression: compare against the current ACTIVE release's passRate.
  const activeRelease = await db.brainRelease.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { activatedAt: "desc" },
  });
  const activeSummary = safeParse<{ passRate?: number }>(activeRelease?.evaluationSummary);
  const activePassRate = activeSummary?.passRate ?? null;
  const regressionRate =
    activePassRate !== null ? Math.max(0, activePassRate - passRate) : 0;

  // Decision matrix.
  let decision: ReleaseDecision;
  let summary: string;

  if (passRate < WARN_THRESHOLD) {
    decision = "BLOCKED";
    summary = `passRate=${passRate.toFixed(2)} < ${WARN_THRESHOLD} — release blocked`;
  } else if (regressionRate > REGRESSION_THRESHOLD) {
    decision = "BLOCKED";
    summary = `regression=${(regressionRate * 100).toFixed(1)}pp > ${REGRESSION_THRESHOLD * 100}pp — release blocked`;
  } else if (passRate >= PASS_THRESHOLD) {
    decision = "PASS";
    summary = `passRate=${passRate.toFixed(2)} — no material regression (caseCount=${caseCount})`;
  } else {
    decision = "PASS_WITH_WARNINGS";
    summary = `passRate=${passRate.toFixed(2)} (>= ${WARN_THRESHOLD}, < ${PASS_THRESHOLD}) — acceptable but monitor`;
  }

  // Persist the evaluation summary + transition to TESTING (idempotent).
  await db.brainRelease.update({
    where: { id: releaseId },
    data: {
      status: "TESTING",
      evaluationSummary: JSON.stringify({
        passRate,
        regressionRate,
        caseCount,
        decision,
        evaluatedAt: new Date().toISOString(),
        activeReleaseIdCompared: activeRelease?.id ?? null,
      }),
    },
  });

  const tenantId = await resolveAuditTenant();
  await writeAuditEvent({
    tenantId,
    actorType: "system",
    actorId: "release-evaluator",
    action: "release.evaluated",
    target: releaseId,
    reason: summary,
    metadata: {
      decision,
      passRate,
      regressionRate,
      caseCount,
    },
    severity: decision === "BLOCKED" ? "WARN" : "INFO",
  });

  await ZeroCostGovernor.record("learning_event");
  return { decision, passRate, regressionRate, summary };
}

// ============================================================
// 3. approveRelease
// ============================================================

/**
 * Approve a release. Only releases that have been evaluated with a decision
 * of PASS or PASS_WITH_WARNINGS can be approved. The release transitions
 * from TESTING → APPROVED.
 *
 * Never activates the release — call activateRelease() separately.
 */
export async function approveRelease(
  releaseId: string,
  approvedBy: string,
): Promise<void> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    throw new Error(
      `governor denied learning_event — cannot approve release: ${gate.reason ?? "unknown"}`,
    );
  }

  const release = await db.brainRelease.findUnique({
    where: { id: releaseId },
  });
  if (!release) {
    throw new Error("release not found");
  }
  if (release.status !== "TESTING") {
    throw new Error(
      `release is in status ${release.status} — only TESTING releases can be approved`,
    );
  }

  const summary = safeParse<{
    decision?: ReleaseDecision;
    passRate?: number;
    regressionRate?: number;
  }>(release.evaluationSummary);
  if (!summary || !summary.decision) {
    throw new Error("release has not been evaluated — call evaluateRelease() first");
  }
  if (summary.decision === "BLOCKED") {
    throw new Error(
      `release evaluation returned BLOCKED (passRate=${summary.passRate}, regression=${summary.regressionRate}) — cannot approve`,
    );
  }

  await db.brainRelease.update({
    where: { id: releaseId },
    data: { status: "APPROVED" },
  });

  const tenantId = await resolveAuditTenant();
  await writeAuditEvent({
    tenantId,
    actorType: "human",
    actorId: approvedBy,
    action: "release.approved",
    target: releaseId,
    reason: `Approved after evaluation decision=${summary.decision}`,
    metadata: {
      decision: summary.decision,
      passRate: summary.passRate,
      regressionRate: summary.regressionRate,
    },
  });

  await ZeroCostGovernor.record("learning_event");
}

// ============================================================
// 4. activateRelease
// ============================================================

/**
 * Activate an APPROVED release. Demotes any currently-ACTIVE release to
 * ROLLED_BACK (there can be only one ACTIVE release at any time).
 *
 * Pre-conditions:
 *   - The release must be in APPROVED status.
 *   - There must be no other ACTIVE release (if there is, it is demoted).
 */
export async function activateRelease(releaseId: string): Promise<void> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    throw new Error(
      `governor denied learning_event — cannot activate release: ${gate.reason ?? "unknown"}`,
    );
  }

  const release = await db.brainRelease.findUnique({
    where: { id: releaseId },
  });
  if (!release) {
    throw new Error("release not found");
  }
  if (release.status !== "APPROVED") {
    throw new Error(
      `release is in status ${release.status} — only APPROVED releases can be activated`,
    );
  }

  // Demote any existing ACTIVE release to ROLLED_BACK.
  const currentActive = await db.brainRelease.findFirst({
    where: { status: "ACTIVE" },
  });
  if (currentActive && currentActive.id !== releaseId) {
    await db.brainRelease.update({
      where: { id: currentActive.id },
      data: { status: "ROLLED_BACK" },
    });
    const tenantId = await resolveAuditTenant();
    await writeAuditEvent({
      tenantId,
      actorType: "system",
      actorId: "release-activator",
      action: "release.demoted",
      target: currentActive.id,
      reason: `Demoted to ROLLED_BACK because release ${releaseId} was activated`,
      metadata: { previousActiveId: currentActive.id, newActiveId: releaseId },
    });
  }

  await db.brainRelease.update({
    where: { id: releaseId },
    data: {
      status: "ACTIVE",
      activatedAt: new Date(),
    },
  });

  const tenantId = await resolveAuditTenant();
  await writeAuditEvent({
    tenantId,
    actorType: "system",
    actorId: "release-activator",
    action: "release.activated",
    target: releaseId,
    reason: `Release activated (replaced ${currentActive?.id ?? "none"})`,
    metadata: {
      previousActiveId: currentActive?.id ?? null,
      activatedAt: new Date().toISOString(),
    },
  });

  await ZeroCostGovernor.record("learning_event");
}

// ============================================================
// 5. rollbackRelease
// ============================================================

/**
 * Roll back from the current ACTIVE release to a previous release.
 *
 * Pre-conditions:
 *   - currentReleaseId must be ACTIVE.
 *   - targetReleaseId must be APPROVED (we never re-activate a release that
 *     was never approved — it has not passed the evaluation gate).
 *
 * On success:
 *   - currentReleaseId → ROLLED_BACK
 *   - targetReleaseId → ACTIVE + activatedAt=now
 */
export async function rollbackRelease(opts: {
  currentReleaseId: string;
  targetReleaseId: string;
  reason: string;
}): Promise<void> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) {
    throw new Error(
      `governor denied learning_event — cannot roll back release: ${gate.reason ?? "unknown"}`,
    );
  }

  const [current, target] = await Promise.all([
    db.brainRelease.findUnique({ where: { id: opts.currentReleaseId } }),
    db.brainRelease.findUnique({ where: { id: opts.targetReleaseId } }),
  ]);

  if (!current) {
    throw new Error(`current release ${opts.currentReleaseId} not found`);
  }
  if (!target) {
    throw new Error(`target release ${opts.targetReleaseId} not found`);
  }
  if (current.status !== "ACTIVE") {
    throw new Error(
      `current release is in status ${current.status} — only ACTIVE releases can be rolled back`,
    );
  }
  if (target.status !== "APPROVED" && target.status !== "ROLLED_BACK") {
    throw new Error(
      `target release is in status ${target.status} — only APPROVED or previously-ROLLED_BACK releases can be rolled back to`,
    );
  }

  // Demote current → ROLLED_BACK.
  await db.brainRelease.update({
    where: { id: opts.currentReleaseId },
    data: { status: "ROLLED_BACK" },
  });

  // Promote target → ACTIVE.
  await db.brainRelease.update({
    where: { id: opts.targetReleaseId },
    data: {
      status: "ACTIVE",
      activatedAt: new Date(),
    },
  });

  const tenantId = await resolveAuditTenant();
  await writeAuditEvent({
    tenantId,
    actorType: "system",
    actorId: "release-rollback",
    action: "release.rolled_back",
    target: opts.targetReleaseId,
    reason: opts.reason,
    metadata: {
      currentReleaseId: opts.currentReleaseId,
      targetReleaseId: opts.targetReleaseId,
      rolledBackAt: new Date().toISOString(),
    },
    severity: "WARN",
  });

  await ZeroCostGovernor.record("learning_event");
}

// ============================================================
// 6. getActiveRelease
// ============================================================

/**
 * Returns the currently-ACTIVE release, or null if none exists. There is at
 * most one ACTIVE release at any time (enforced by activateRelease).
 */
export async function getActiveRelease(): Promise<{
  id: string;
  releaseId: string;
  knowledgeSnapshot: string | null;
  memoryPolicyVersion: string | null;
  routerVersion: string | null;
  rerankerVersion: string | null;
  evaluationVersion: string | null;
  promptVersion: string | null;
  toolPolicyVersion: string | null;
  evaluationSummary: string | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  activatedAt: Date | null;
} | null> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return null;

  const release = await db.brainRelease.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { activatedAt: "desc" },
  });

  await ZeroCostGovernor.record("learning_event");
  return release ?? null;
}

// ============================================================
// 7. listReleases
// ============================================================

/**
 * List releases newest-first. Default limit = 50, capped at 200.
 */
export async function listReleases(
  limit: number = 50,
): Promise<Array<{
  id: string;
  releaseId: string;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  evaluationSummary: string | null;
}>> {
  const gate = await ZeroCostGovernor.canPerform("learning_event");
  if (!gate.allowed) return [];

  const cap = Math.max(1, Math.min(200, limit));
  const rows = await db.brainRelease.findMany({
    orderBy: { createdAt: "desc" },
    take: cap,
    select: {
      id: true,
      releaseId: true,
      status: true,
      createdBy: true,
      createdAt: true,
      activatedAt: true,
      evaluationSummary: true,
    },
  });

  await ZeroCostGovernor.record("learning_event");
  return rows;
}

// ============================================================
// Internal: short SHA-256 hash for knowledge snapshots
// ============================================================

/**
 * Compute a short hex hash of the input string. Uses the Web Crypto API
 * (SubtleCrypto) when available; falls back to a non-cryptographic FNV-1a
 * hash on environments where SubtleCrypto is unavailable.
 *
 * The hash is used ONLY for change detection (does the snapshot differ from
 * a previous one?) — it is not used for any security decision.
 */
async function sha256Short(input: string): Promise<string> {
  // Web Crypto (Node 18+, browsers, edge runtimes).
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { crypto?: Crypto }).crypto?.subtle?.digest === "function"
  ) {
    try {
      const data = new TextEncoder().encode(input);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
      const bytes = new Uint8Array(digest);
      // First 8 bytes → 16 hex chars. Collisions over 16 hex chars are
      // astronomically unlikely for change-detection use.
      let hex = "";
      for (let i = 0; i < 8; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
      }
      return hex;
    } catch {
      // fall through to FNV-1a
    }
  }
  return fnv1aHex(input);
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

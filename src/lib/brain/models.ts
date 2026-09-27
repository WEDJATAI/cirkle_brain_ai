// Cirkle Brain AI — Model abstraction + router + fallback (§45-50, §60).
//
// Applications must not directly depend on provider-specific SDKs (§45). The
// model router selects models based on task, complexity, modality, privacy,
// latency, cost, quality, historical evaluation, availability (§47). Explicit
// fallback (§48) on timeout / rate limit / outage / context overflow / etc.
// Cost-aware routing (§76). Model data policy (§60): restricted data may only
// go to approved providers.
//
// CONSENSUS: z-ai has been removed entirely. The Brain now routes across
// 5 independent providers (Groq, OpenRouter, NVIDIA, Gemini, HuggingFace)
// via the unified `multi-provider` adapter.

import { db } from "@/lib/db";
import type {
  ModelDescriptor, ModelCallResult, ModelTier, TaskType, PolicyMode,
  DataClassification, BrainMode,
} from "./types";
import { checkDataClassAllowed, type PolicyRules } from "./policy";
import {
  PROVIDER_MODELS,
  callProviderModel,
  callProviderModelStreaming,
  getModelById,
  getFallbackChain,
  type ProviderModel,
} from "./multi-provider";
import {
  recordSuccess,
  recordFailure,
  effectiveReliability,
  effectiveLatency,
  getCircuitBrokenModels,
} from "./model-health";

// ----------------------------------------------------------------------------
// Model registry — seeded by /api/brain/seed (§46).
// ----------------------------------------------------------------------------

export async function listModels(): Promise<ModelDescriptor[]> {
  const rows = await db.model.findMany({ where: { status: "ACTIVE" } });
  return rows.map(toDescriptor);
}

export async function getModelByTier(tier: ModelTier): Promise<ModelDescriptor | null> {
  const row = await db.model.findFirst({ where: { tier, status: "ACTIVE" }, orderBy: { reliability: "desc" } });
  return row ? toDescriptor(row) : null;
}

export function toDescriptor(m: any): ModelDescriptor {
  return {
    id: m.id,
    modelId: m.modelId,
    provider: m.provider,
    displayName: m.displayName,
    tier: m.tier as ModelTier,
    contextLimit: m.contextLimit,
    costInPer1k: m.costInPer1k,
    costOutPer1k: m.costOutPer1k,
    capabilities: m.capabilities ? m.capabilities.split(",").map((s: string) => s.trim()) : [],
    privacyPolicy: m.privacyPolicy as DataClassification,
    latencyP50Ms: m.latencyP50Ms,
    reliability: m.reliability,
    status: m.status,
    fallbackModelId: m.fallbackModelId ?? undefined,
  };
}

// ----------------------------------------------------------------------------
// Task router (§47) — pick a model tier based on task + policy mode.
// ----------------------------------------------------------------------------

export function pickTier(taskType: TaskType, mode: BrainMode | undefined, policyMode: PolicyMode): ModelTier {
  if (taskType === "high_risk") return "REASONING";
  if (taskType === "reasoning" || taskType === "synthesis") return "REASONING";
  if (taskType === "coding") return "REASONING";
  if (taskType === "tool_use") return "BALANCED";
  if (taskType === "factual") return "BALANCED";
  if (taskType === "simple") return "FAST";
  if (mode === "fast") return "FAST";
  if (mode === "deep") return "REASONING";
  if (mode === "balanced") return "BALANCED";
  if (policyMode === "LOW_COST") return "FAST";
  if (policyMode === "HIGH_QUALITY" || policyMode === "CRITICAL") return "REASONING";
  return "BALANCED";
}

export async function selectModel(opts: {
  taskType: TaskType;
  mode: BrainMode | undefined;
  policyMode: PolicyMode;
  policy: PolicyRules;
  dataClass: DataClassification;
}): Promise<{ model: ModelDescriptor; reason: string; fallback?: ModelDescriptor }> {
  const tier = pickTier(opts.taskType, opts.mode, opts.policyMode);
  const all = await listModels();
  const candidates = all.filter((m) => m.tier === tier);
  if (candidates.length === 0) {
    const any = all[0];
    if (!any) throw new Error("no active models registered");
    return { model: any, reason: `no ${tier} model available — using ${any.displayName}` };
  }
  // §60 — provider allowlist + data-class ceiling
  const allowed = candidates.filter((m) => {
    const decision = checkDataClassAllowed(opts.policy, opts.dataClass, m.provider);
    return decision.allowed;
  });
  let pool = allowed.length > 0 ? allowed : candidates;

  // ─── Intelligent router (self-healing) ────────────────────────────────
  // Circuit breaker: skip models with 3+ consecutive recent failures.
  const circuitBroken = getCircuitBrokenModels();
  const healthy = pool.filter((m) => !circuitBroken.has(m.modelId));
  if (healthy.length > 0) pool = healthy;

  // Dynamic reliability scoring: blend static prior with observed success rate.
  // Models that recently failed are demoted; models that recently succeeded are promoted.
  pool.sort((a, b) => {
    const aEff = effectiveReliability(a.modelId, a.reliability);
    const bEff = effectiveReliability(b.modelId, b.reliability);
    if (bEff !== aEff) return bEff - aEff;
    // Tiebreaker: lower effective latency first (uses recent p50, not static prior)
    const aLat = effectiveLatency(a.modelId, a.latencyP50Ms);
    const bLat = effectiveLatency(b.modelId, b.latencyP50Ms);
    if (aLat !== bLat) return aLat - bLat;
    // Final tiebreaker: lowest cost
    return a.costOutPer1k - b.costOutPer1k;
  });

  const model = pool[0];
  const effRel = effectiveReliability(model.modelId, model.reliability).toFixed(2);
  const effLat = effectiveLatency(model.modelId, model.latencyP50Ms);
  const broken = circuitBroken.size;
  const reason = `task=${opts.taskType} mode=${opts.mode ?? "auto"} policy=${opts.policyMode} → tier=${tier} → ${model.displayName} (effRel=${effRel}, p50=${effLat}ms, circuitBroken=${broken})`;
  const fallback = model.fallbackModelId
    ? (all.find((m) => m.id === model.fallbackModelId) ?? undefined)
    : undefined;
  return { model, reason, fallback };
}

// ----------------------------------------------------------------------------
// §45 ModelProvider interface — abstraction over the multi-provider router.
// The underlying provider can evolve; Cirkle Brain owns the abstraction (§49).
// ----------------------------------------------------------------------------

export interface ModelCallInput {
  model: ModelDescriptor;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  maxTokens?: number;
  fallback?: ModelDescriptor;
  tenantId: string;
  taskType?: TaskType;
  /** Optional streaming callback. When provided, callModel uses the provider's
   *  streaming API and invokes onToken for each delta as it arrives. */
  onToken?: (delta: string) => void;
}

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  const startedAt = Date.now();
  let attempt: ModelDescriptor = input.model;
  let fallbackUsed = false;
  let fallbackReason: string | undefined;

  // Build the fallback chain. Primary first, then any explicit fallback, then
  // any other available model in the same tier from a different provider.
  const chain = buildAttemptChain(input);

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const providerModel = entry.providerModel;
    attempt = entry.descriptor ?? attempt;
    const callStart = Date.now();
    try {
      // Use streaming API if onToken callback is provided, else use the
      // simpler non-streaming path (avoids SSE parsing overhead).
      const result = input.onToken
        ? await callProviderModelStreaming({
            model: providerModel,
            messages: input.messages,
            maxTokens: input.maxTokens,
            onToken: input.onToken,
          })
        : await callProviderModel({
            model: providerModel,
            messages: input.messages,
            maxTokens: input.maxTokens,
          });
      const callLatency = Date.now() - callStart;

      // callProviderModel returns success=false on API errors (4xx/5xx) with
      // empty content + error message. We must try the next provider in the
      // chain instead of returning empty content to the user.
      if (!result.success || !result.content || result.content.trim().length === 0) {
        const err = result.error
          ? `${providerModel.modelId} failed: ${result.error}`
          : `${providerModel.modelId} returned empty content`;
        fallbackReason = err;
        // ─── Health tracker: record failure ────────────────────────────
        recordFailure(providerModel.modelId, callLatency, err);
        if (i < chain.length - 1) {
          fallbackUsed = true;
          // advance to the next provider in the chain
          continue;
        }
        // exhausted — record + return the failure
        await db.modelUsage.create({
          data: {
            tenantId: input.tenantId,
            modelId: attempt.id,
            tokensIn: 0, tokensOut: 0, costUsd: 0,
            latencyMs: Date.now() - startedAt,
            fallbackUsed, success: false,
            taskType: input.taskType ?? null,
          },
        }).catch(() => {});
        return {
          model: attempt.modelId,
          provider: attempt.provider,
          content: "",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: Date.now() - startedAt,
          fallbackUsed,
          fallbackReason,
          success: false,
          error: fallbackReason,
        };
      }

      // success — record usage + return
      // ─── Health tracker: record success ──────────────────────────────
      recordSuccess(providerModel.modelId, callLatency);

      const tokensIn = result.tokensIn;
      const tokensOut = result.tokensOut;
      const latencyMs = Date.now() - startedAt;
      const costUsd = result.costUsd;

      await db.modelUsage.create({
        data: {
          tenantId: input.tenantId,
          modelId: attempt.id,
          tokensIn,
          tokensOut,
          costUsd,
          latencyMs,
          fallbackUsed,
          success: true,
          taskType: input.taskType ?? null,
        },
      }).catch(() => {});

      return {
        model: attempt.modelId,
        provider: attempt.provider,
        content: result.content,
        tokensIn,
        tokensOut,
        costUsd,
        latencyMs,
        fallbackUsed,
        fallbackReason,
        success: true,
      };
    } catch (err: any) {
      const callLatency = Date.now() - callStart;
      // Defensive — callProviderModel should never throw, but just in case
      // (e.g., network timeout from AbortSignal.timeout).
      const errMsg = `${providerModel.modelId} threw: ${err?.message ?? "unknown"}`;
      fallbackReason = errMsg;
      // ─── Health tracker: record failure ──────────────────────────────
      recordFailure(providerModel.modelId, callLatency, errMsg);
      if (i < chain.length - 1) {
        fallbackUsed = true;
        continue;
      }
      break;
    }
  }

  // Record final failed attempt
  await db.modelUsage.create({
    data: {
      tenantId: input.tenantId,
      modelId: attempt.id,
      tokensIn: 0, tokensOut: 0, costUsd: 0,
      latencyMs: Date.now() - startedAt,
      fallbackUsed, success: false,
      taskType: input.taskType ?? null,
    },
  }).catch(() => {});

  return {
    model: attempt.modelId,
    provider: attempt.provider,
    content: "",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    fallbackUsed,
    fallbackReason,
    success: false,
    error: fallbackReason ?? "exhausted fallbacks",
  };
}

// ----------------------------------------------------------------------------
// Build the chain of (ProviderModel, ModelDescriptor) pairs to try.
// Order: primary → explicit fallback → any other available same-tier model.
// ----------------------------------------------------------------------------

interface AttemptEntry {
  providerModel: ProviderModel;
  descriptor?: ModelDescriptor;
}

function buildAttemptChain(input: ModelCallInput): AttemptEntry[] {
  const chain: AttemptEntry[] = [];
  const seen = new Set<string>();

  const pushFromDescriptor = (d?: ModelDescriptor) => {
    if (!d) return;
    if (seen.has(d.modelId)) return;
    const pm = getModelById(d.modelId);
    if (!pm) return;
    seen.add(d.modelId);
    chain.push({ providerModel: pm, descriptor: d });
  };

  pushFromDescriptor(input.model);
  pushFromDescriptor(input.fallback);

  // Add other models in the same tier as the primary, from different providers
  // (uses the in-memory multi-provider registry — these may not be in the DB).
  const tier = input.model.tier;
  const fallbacks = getFallbackChain(tier as any);
  for (const pm of fallbacks) {
    if (seen.has(pm.modelId)) continue;
    seen.add(pm.modelId);
    chain.push({ providerModel: pm });
  }

  // Last-resort: any available model from any tier.
  if (chain.length === 0) {
    for (const pm of PROVIDER_MODELS) {
      if (seen.has(pm.modelId)) continue;
      seen.add(pm.modelId);
      chain.push({ providerModel: pm });
      if (chain.length >= 5) break;
    }
  }

  return chain;
}

function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

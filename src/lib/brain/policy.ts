// WEDJAT BRAIN V2 — Policy engine (§100-103).
//
// Policies must be executable code/configuration (Rule: do not encode critical
// rules only inside natural-language prompts). Policies are versioned (§101),
// application-scoped with inheritance (§102): global → application → tenant →
// user/session, with explicit override rules.

import { db } from "@/lib/db";
import type { IdentityContext, DataClassification, PolicyMode, RiskLevel } from "./types";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  rulesApplied: string[];
  policyVersion?: number;
}

export interface PolicyRules {
  maxCostPerRequest?: number;
  maxLatencyMs?: number;
  allowedDataClasses: DataClassification[];     // classes the model may receive
  allowedProviders: string[];                    // §60 provider allowlist
  allowedTools: string[] | "*";                  // §51
  toolRiskCeiling: RiskLevel;                    // max auto-approved risk
  humanApprovalRequiredAbove: RiskLevel;         // §56
  memoryRetentionDays: number;
  knowledgePromotionRequiresEvidence: boolean;
  externalSearchAllowed: boolean;
  auditSignificantActions: boolean;
}

const DEFAULT_RULES: PolicyRules = {
  maxCostPerRequest: 0.5,
  maxLatencyMs: 30000,
  allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
  // CONSENSUS: z-ai removed as PRIMARY provider. z-ai is now a LAST-RESORT
  // FALLBACK when all 5 external providers (Groq, OpenRouter, NVIDIA, Gemini,
  // HuggingFace) fail. It's included in allowedProviders so the fallback chain
  // can reach it. When new valid external keys are provided, the health tracker
  // will deprioritize z-ai (lower reliability = lower priority).
  allowedProviders: ["groq", "openrouter", "nvidia", "gemini", "huggingface", "zai"],
  allowedTools: "*",
  toolRiskCeiling: "MEDIUM",
  humanApprovalRequiredAbove: "MEDIUM",
  memoryRetentionDays: 365,
  knowledgePromotionRequiresEvidence: true,
  externalSearchAllowed: true,
  auditSignificantActions: true,
};

/** Resolve the effective policy for an identity (global → app → tenant override). */
export async function resolvePolicy(identity: IdentityContext): Promise<PolicyRules> {
  // Start from defaults, then layer global → application policies.
  let effective: PolicyRules = { ...DEFAULT_RULES };

  const policies = await db.policy.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { tenantId: null, applicationId: null },           // global
        { tenantId: identity.tenant.id, applicationId: null }, // tenant-wide
        { tenantId: identity.tenant.id, applicationId: identity.application.id }, // app-specific
      ],
    },
    orderBy: { version: "desc" },
  });

  for (const p of policies) {
    try {
      const parsed = JSON.parse(p.rules) as Partial<PolicyRules>;
      effective = { ...effective, ...parsed };
    } catch {
      // ignore malformed policy rules — fail safe to defaults
    }
  }

  // §60: application modelPolicy constrains cost/quality trade-off
  // (LOW_COST → tighter budget; CRITICAL → allow higher cost, require stronger models)
  const mode = identity.application.modelPolicy;
  if (mode === "LOW_COST") {
    effective.maxCostPerRequest = Math.min(effective.maxCostPerRequest ?? 0.5, 0.1);
  } else if (mode === "HIGH_QUALITY") {
    effective.maxCostPerRequest = Math.max(effective.maxCostPerRequest ?? 0.5, 1.0);
  } else if (mode === "CRITICAL") {
    effective.maxCostPerRequest = Math.max(effective.maxCostPerRequest ?? 0.5, 5.0);
    effective.toolRiskCeiling = "HIGH";
    effective.knowledgePromotionRequiresEvidence = true;
  }

  return effective;
}

/** Check whether a tool may be invoked given current policy + identity. */
export function checkToolAllowed(
  policy: PolicyRules,
  identity: IdentityContext,
  toolId: string,
  risk: RiskLevel,
): PolicyDecision {
  const rulesApplied: string[] = [];
  if (policy.allowedTools !== "*" && !policy.allowedTools.includes(toolId)) {
    return { allowed: false, reason: `tool ${toolId} not in allowlist`, rulesApplied: ["tool.allowlist"] };
  }
  rulesApplied.push("tool.allowlist.pass");
  // §56: HIGH/CRITICAL require human approval
  if (riskAbove(risk, policy.toolRiskCeiling)) {
    return {
      allowed: true,
      reason: `tool ${toolId} requires human approval (risk=${risk})`,
      rulesApplied: [...rulesApplied, "human.approval.required"],
    };
  }
  return { allowed: true, reason: `tool ${toolId} auto-approved (risk=${risk})`, rulesApplied };
}

/** Check whether a data classification may be sent to a provider (§60). */
export function checkDataClassAllowed(policy: PolicyRules, dataClass: DataClassification, provider: string): PolicyDecision {
  if (!policy.allowedProviders.includes(provider)) {
    return { allowed: false, reason: `provider ${provider} not in allowlist`, rulesApplied: ["provider.allowlist"] };
  }
  const rank: DataClassification[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];
  const maxIdx = Math.max(...policy.allowedDataClasses.map((c) => rank.indexOf(c)));
  const idx = rank.indexOf(dataClass);
  if (idx > maxIdx) {
    return {
      allowed: false,
      reason: `data class ${dataClass} exceeds allowed maximum ${rank[maxIdx]} for provider ${provider}`,
      rulesApplied: ["data.class.ceiling"],
    };
  }
  return { allowed: true, reason: `data class ${dataClass} permitted for ${provider}`, rulesApplied: ["data.class.ceiling"] };
}

function riskAbove(a: RiskLevel, b: RiskLevel): boolean {
  const order: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  return order.indexOf(a) > order.indexOf(b);
}

export function policyModeFor(mode: PolicyMode): { preferTier: string; maxCostPer1k: number } {
  switch (mode) {
    case "LOW_COST": return { preferTier: "FAST", maxCostPer1k: 0.5 };
    case "BALANCED": return { preferTier: "BALANCED", maxCostPer1k: 2 };
    case "HIGH_QUALITY": return { preferTier: "REASONING", maxCostPer1k: 10 };
    case "CRITICAL": return { preferTier: "REASONING", maxCostPer1k: 50 };
  }
}

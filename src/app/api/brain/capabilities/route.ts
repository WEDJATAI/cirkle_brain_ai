// GET /api/brain/capabilities — Brain capability manifest (§13).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seedBrain } from "@/lib/brain/seed";
import {
  PROVIDER_MODELS,
  getAvailableProviders,
  isProviderAvailable,
  getProviderEnvVar,
  type ProviderName,
} from "@/lib/brain/multi-provider";
import { getHealthStats } from "@/lib/brain/model-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tenantCount = await db.tenant.count();
  if (tenantCount === 0) await seedBrain();

  const [tenants, applications, models, tools, knowledgeItems, memoryItems] = await Promise.all([
    db.tenant.count(),
    db.application.count(),
    db.model.count({ where: { status: "ACTIVE" } }),
    db.tool.count({ where: { status: "ACTIVE" } }),
    db.knowledgeItem.count({ where: { status: "ACTIVE" } }),
    db.memoryItem.count({ where: { status: "ACTIVE" } }),
  ]);

  // Build multi-provider router status across all 5 providers (no z-ai).
  const allProviders: ProviderName[] = ["groq", "openrouter", "nvidia", "gemini", "huggingface"];
  const providers = allProviders.map(name => ({
    name,
    envVar: getProviderEnvVar(name),
    available: isProviderAvailable(name),
    modelCount: PROVIDER_MODELS.filter(m => m.provider === name).length,
    tiers: Array.from(new Set(PROVIDER_MODELS.filter(m => m.provider === name).map(m => m.tier))),
  }));

  // Health stats from the intelligent router (per-model success rate, p50 latency,
  // circuit breaker state)
  const healthStats = getHealthStats();

  return NextResponse.json({
    brain: "Cirkle Brain AI",
    version: "0.1.0",
    spec: "model-independent cognitive operating layer",
    router: {
      providers,
      availableProviders: getAvailableProviders(),
      totalModels: PROVIDER_MODELS.length,
      zaiRemoved: true,   // consensus — z-ai fully removed
      healthStats,        // per-model success rate, p50 latency, circuit breaker
    },
    endpoints: [
      "POST /api/brain/respond",
      "POST /api/brain/retrieve",
      "POST /api/brain/memory",
      "POST /api/brain/knowledge",
      "POST /api/brain/tools/execute",
      "POST /api/brain/tools/approve",
      "POST /api/brain/evaluate",
      "GET  /api/brain/capabilities",
      "GET  /api/brain/health",
      "GET  /api/brain/trace?requestId=...",
      "GET  /api/brain/audit",
      "GET  /api/brain/metrics",
      "POST /api/brain/seed",
      "GET  /api/brain/candidates",
    ],
    domains: [
      "identity", "policy", "memory", "knowledge", "retrieval", "context",
      "models", "tools", "verification", "learning", "evaluation", "observability", "audit",
    ],
    counts: { tenants, applications, models, tools, knowledgeItems, memoryItems },
    principles: [
      "The model is NOT the Brain (§2)",
      "Authorization is outside the model (§4 Rule 3)",
      "Retrieved content is untrusted (§4 Rule 4)",
      "Tenant isolation is mandatory (§4 Rule 5, §62)",
      "Side effects require explicit authorization (§4 Rule 6, §55)",
      "Important knowledge has provenance (§4 Rule 7, §28)",
      "Learning is controlled (§4 Rule 9, §97)",
    ],
  });
}

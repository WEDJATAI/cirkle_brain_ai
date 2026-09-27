// Cirkle Brain AI — Provider Pre-Warming
//
// On the first request after server start, makes a tiny warmup call to each
// available provider. This populates the health tracker with initial data
// so the intelligent router can make informed decisions from the very first
// real query (instead of learning from the user's first few queries).
//
// Runs in the background (fire-and-forget) — doesn't block the request.

import { PROVIDER_MODELS, getAvailableProviders, callProviderModel } from "./multi-provider";
import { recordSuccess, recordFailure } from "./model-health";

let warmed = false;

const WARMUP_PROMPT = "Reply with exactly: OK";

/**
 * Warm up all available providers with a tiny test call. Fire-and-forget —
 * does not block the caller. Idempotent: only runs once per process.
 */
export function warmupProviders(): void {
  if (warmed) return;
  warmed = true;

  const available = getAvailableProviders();
  if (available.length === 0) return;

  // Fire-and-forget — run in background
  (async () => {
    // Pick one model per provider (the fastest in each)
    const warmupModels = available.map(provider => {
      const models = PROVIDER_MODELS.filter(m => m.provider === provider);
      // Pick the FAST tier model with lowest latency
      const fast = models.filter(m => m.tier === "FAST").sort((a, b) => a.latencyP50Ms - b.latencyP50Ms);
      return (fast[0] ?? models[0])!;
    }).filter(Boolean);

    // Make warmup calls in parallel
    const results = await Promise.allSettled(
      warmupModels.map(model =>
        callProviderModel({
          model,
          messages: [
            { role: "system", content: "You are a warmup probe. Reply with exactly: OK" },
            { role: "user", content: WARMUP_PROMPT },
          ],
          maxTokens: 10,
        }),
      ),
    );

    // Record health stats from warmup results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const model = warmupModels[i];
      if (!model) continue;
      if (result.status === "fulfilled" && result.value.success) {
        recordSuccess(model.modelId, result.value.latencyMs);
        console.log(`[warmup] ✓ ${model.modelId} — ${result.value.latencyMs}ms`);
      } else if (result.status === "fulfilled") {
        recordFailure(model.modelId, result.value.latencyMs, result.value.error ?? "failed");
        console.log(`[warmup] ✗ ${model.modelId} — ${result.value.error?.slice(0, 80)}`);
      } else {
        recordFailure(model.modelId, 0, String(result.reason).slice(0, 200));
        console.log(`[warmup] ✗ ${model.modelId} — rejected: ${String(result.reason).slice(0, 80)}`);
      }
    }
    console.log(`[warmup] Complete — ${available.length} providers tested`);
  })().catch(() => {
    // Swallow — warmup failure is non-fatal
  });
}

/** Reset warmed state (for testing). */
export function resetWarmup(): void {
  warmed = false;
}

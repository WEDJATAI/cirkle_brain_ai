// Cirkle Brain AI — Model Health Tracker
//
// Tracks per-model success rate, latency, and error patterns over a sliding
// window of the last N calls. The intelligent router uses this to dynamically
// rank models — models that recently failed are demoted, models that recently
// succeeded are promoted.
//
// This is the "self-healing" intelligence layer: the static `reliability`
// field in the DB is the prior, but the live `effectiveReliability` reflects
// recent observed behavior. If a model's key gets revoked or the API starts
// returning 429s, the router will naturally stop sending traffic to it.
//
// In-memory only (per-process). Resets on dev server restart. For production
// multi-instance, this would be backed by Redis or a Turso counter table.

interface ModelHealth {
  modelId: string;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  totalCalls: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;  // resets on success
}

const WINDOW_SIZE = 50; // track last 50 calls per model
const healthMap = new Map<string, ModelHealth>();
const recentCalls = new Map<string, number[]>(); // modelId → array of recent latencies

// Decay factor — older failures matter less than recent ones.
// Every 5 minutes, the effective reliability drifts 10% back toward the static prior.
const DECAY_INTERVAL_MS = 5 * 60 * 1000;
const DECAY_FACTOR = 0.90;
let lastDecayAt = Date.now();

/** Record a successful model call. */
export function recordSuccess(modelId: string, latencyMs: number): void {
  const h = healthMap.get(modelId) ?? newHealth(modelId);
  h.successCount++;
  h.totalCalls++;
  h.totalLatencyMs += latencyMs;
  h.lastSuccessAt = Date.now();
  h.consecutiveFailures = 0;
  h.lastError = null;
  healthMap.set(modelId, h);

  // Track recent latencies for p50/p95
  const recent = recentCalls.get(modelId) ?? [];
  recent.push(latencyMs);
  if (recent.length > WINDOW_SIZE) recent.shift();
  recentCalls.set(modelId, recent);

  maybeDecay();
}

/** Record a failed model call. */
export function recordFailure(modelId: string, latencyMs: number, error: string): void {
  const h = healthMap.get(modelId) ?? newHealth(modelId);
  h.failureCount++;
  h.totalCalls++;
  h.totalLatencyMs += latencyMs;
  h.lastFailureAt = Date.now();
  h.consecutiveFailures++;
  h.lastError = error.slice(0, 200);
  healthMap.set(modelId, h);

  maybeDecay();
}

/** Get the effective reliability for a model (0..1).
 *  Combines the static prior (from DB) with the live observed success rate.
 *  Models with 0 calls return the prior. Models with recent failures are
 *  demoted proportional to their failure rate. */
export function effectiveReliability(modelId: string, priorReliability: number): number {
  applyDecayIfNeeded();

  const h = healthMap.get(modelId);
  if (!h || h.totalCalls === 0) return priorReliability;

  // Observed success rate over the sliding window
  const observedSuccess = h.successCount / h.totalCalls;

  // Confidence weight — more calls = more confidence in the observed rate.
  // At 10 calls, observed weight = 0.5. At 50+ calls, observed weight = 1.0.
  const observedWeight = Math.min(1, h.totalCalls / 50);

  // Penalty for consecutive failures (recent failures matter more)
  const consecPenalty = Math.min(0.5, h.consecutiveFailures * 0.1);

  // Blend: prior * (1 - observedWeight) + observed * observedWeight - consecPenalty
  const blended = priorReliability * (1 - observedWeight) + observedSuccess * observedWeight;
  return Math.max(0, blended - consecPenalty);
}

/** Get the average latency for a model (uses recent window for responsiveness). */
export function effectiveLatency(modelId: string, priorLatencyMs: number): number {
  const recent = recentCalls.get(modelId);
  if (!recent || recent.length === 0) return priorLatencyMs;
  // Use median (p50) of recent calls for stability
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}

/** Get health stats for the /api/brain/capabilities endpoint (observability). */
export function getHealthStats(): Array<{
  modelId: string;
  totalCalls: number;
  successRate: number;
  p50LatencyMs: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}> {
  applyDecayIfNeeded();
  const out = [];
  for (const [modelId, h] of healthMap.entries()) {
    out.push({
      modelId,
      totalCalls: h.totalCalls,
      successRate: h.totalCalls > 0 ? h.successCount / h.totalCalls : 0,
      p50LatencyMs: effectiveLatency(modelId, 0),
      consecutiveFailures: h.consecutiveFailures,
      lastError: h.lastError,
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
    });
  }
  return out;
}

/** Get the list of models currently considered "circuit-broken" (3+ consecutive failures).
 *  These are temporarily removed from the candidate pool. */
export function getCircuitBrokenModels(): Set<string> {
  applyDecayIfNeeded();
  const broken = new Set<string>();
  for (const [modelId, h] of healthMap.entries()) {
    // 3 consecutive failures = circuit broken (Open circuit breaker pattern)
    // Auto-resets after 60 seconds of no calls (the decay)
    if (h.consecutiveFailures >= 3) {
      const sinceLastFailure = Date.now() - (h.lastFailureAt ?? 0);
      if (sinceLastFailure < 60000) {
        broken.add(modelId);
      }
    }
  }
  return broken;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function newHealth(modelId: string): ModelHealth {
  return {
    modelId,
    successCount: 0,
    failureCount: 0,
    totalLatencyMs: 0,
    totalCalls: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}

function maybeDecay(): void {
  const now = Date.now();
  if (now - lastDecayAt > DECAY_INTERVAL_MS) {
    applyDecay();
    lastDecayAt = now;
  }
}

function applyDecayIfNeeded(): void {
  const now = Date.now();
  if (now - lastDecayAt > DECAY_INTERVAL_MS) {
    applyDecay();
    lastDecayAt = now;
  }
}

function applyDecay(): void {
  // Decay all health stats by DECAY_FACTOR — older observations fade.
  for (const [modelId, h] of healthMap.entries()) {
    h.successCount = Math.floor(h.successCount * DECAY_FACTOR);
    h.failureCount = Math.floor(h.failureCount * DECAY_FACTOR);
    h.totalCalls = h.successCount + h.failureCount;
    h.totalLatencyMs = Math.floor(h.totalLatencyMs * DECAY_FACTOR);
    // Don't decay consecutiveFailures — only a success resets those
    healthMap.set(modelId, h);
  }
  // Decay recent latencies too
  for (const [modelId, recent] of recentCalls.entries()) {
    const newSize = Math.floor(recent.length * DECAY_FACTOR);
    recentCalls.set(modelId, recent.slice(-newSize));
  }
}

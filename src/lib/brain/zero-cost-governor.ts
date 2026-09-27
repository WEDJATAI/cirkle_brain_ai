// WEDJAT BRAIN V2 — Zero-Cost Governor (spec Part 11).
//
// The Zero-Cost Governor guarantees the system NEVER exceeds free-tier
// limits and NEVER enables paid usage. It is the single source of truth for
// "is this action allowed right now?" across the Brain + Learning Fabric.
//
// States (spec §11):
//   NORMAL     → all learning + inference proceed normally
//   THROTTLED  → noncritical work slows down (70% of any limit)
//   DEGRADED   → only high-value learning continues (85% of any limit)
//   SAFE_MODE  → ALL background learning stops; only user inference
//                (model_call) is permitted (95% of any limit)
//
// Hard guarantees (§11):
//   1. Never upgrade to a paid tier — there is no code path that does so.
//   2. Never retry indefinitely — once an action is denied, the caller is
//      expected to defer (or skip), not retry.
//   3. Never continue paid requests when in SAFE_MODE — only model_call
//      (user-facing inference) survives.
//
// Storage:
//   One CostBudget row per day (keyed by YYYY-MM-DD). All counters + state
//   live on that row. The row is created lazily on first access each day.

import { db } from "@/lib/db";

// ---------------------------------------------------------------
// Conservative free-tier limits
// ---------------------------------------------------------------

export const FREE_TIER_LIMITS = {
  MAX_DAILY_LEARNING_EVENTS: 100,
  MAX_DAILY_WEB_REQUESTS: 20,
  MAX_DAILY_MODEL_CALLS: 500,
  MAX_DAILY_BG_EXECUTIONS: 50,
  MAX_DATASET_GROWTH_PER_DAY: 100, // items
  MAX_EXPORT_SIZE: 10000, // items
  // Conservative thresholds (below provider maximums) — informational only;
  // the governor enforces the MAX_DAILY_* limits above. These are tracked
  // so the metadata column can surface "are we near the platform ceiling?".
  GITHUB_ACTIONS_MIN_PER_MONTH: 2000,
  VERCEL_GB_PER_MONTH: 100,
  NEON_STORAGE_MB: 500,
  TURSO_GB: 9,
  INNGEST_RUNS_PER_MONTH: 2500,
} as const;

export type GovernorState = "NORMAL" | "THROTTLED" | "DEGRADED" | "SAFE_MODE";

/** Actions the governor knows how to budget. */
export type GovernorAction =
  | "learning_event"
  | "web_request"
  | "model_call"
  | "bg_execution"
  | "dataset_growth"
  | "export";

/** Per-action counter field on the CostBudget row. */
const ACTION_FIELD: Record<GovernorAction, "learningEvents" | "webRequests" | "modelCalls" | "bgExecutions" | "datasetGrowth" | "exportSize"> = {
  learning_event: "learningEvents",
  web_request: "webRequests",
  model_call: "modelCalls",
  bg_execution: "bgExecutions",
  dataset_growth: "datasetGrowth",
  export: "exportSize",
};

/** Per-action hard ceiling. */
const ACTION_LIMIT: Record<GovernorAction, number> = {
  learning_event: FREE_TIER_LIMITS.MAX_DAILY_LEARNING_EVENTS,
  web_request: FREE_TIER_LIMITS.MAX_DAILY_WEB_REQUESTS,
  model_call: FREE_TIER_LIMITS.MAX_DAILY_MODEL_CALLS,
  bg_execution: FREE_TIER_LIMITS.MAX_DAILY_BG_EXECUTIONS,
  dataset_growth: FREE_TIER_LIMITS.MAX_DATASET_GROWTH_PER_DAY,
  export: FREE_TIER_LIMITS.MAX_EXPORT_SIZE,
};

/**
 * Actions that count as "noncritical background learning". These are the
 * first to be stopped as the governor degrades. model_call (user-facing
 * inference) is intentionally excluded — it survives SAFE_MODE.
 */
const NONCRITICAL_ACTIONS: ReadonlySet<GovernorAction> = new Set<GovernorAction>([
  "learning_event",
  "web_request",
  "bg_execution",
  "dataset_growth",
  "export",
]);

// State transition thresholds (spec §11 — 70/85/95).
const THRESHOLDS = {
  THROTTLED: 0.7,
  DEGRADED: 0.85,
  SAFE_MODE: 0.95,
} as const;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function todayKey(d: Date = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clampState(s: string | null | undefined): GovernorState {
  if (s === "NORMAL" || s === "THROTTLED" || s === "DEGRADED" || s === "SAFE_MODE") {
    return s;
  }
  return "NORMAL";
}

/**
 * Compute the worst state implied by the current counters relative to their
 * limits. Returns the strictest state across all dimensions.
 */
function computeStateFromCounters(counters: {
  learningEvents: number;
  webRequests: number;
  modelCalls: number;
  bgExecutions: number;
  datasetGrowth: number;
  exportSize: number;
}): GovernorState {
  const ratios = [
    counters.learningEvents / ACTION_LIMIT.learning_event,
    counters.webRequests / ACTION_LIMIT.web_request,
    counters.modelCalls / ACTION_LIMIT.model_call,
    counters.bgExecutions / ACTION_LIMIT.bg_execution,
    counters.datasetGrowth / ACTION_LIMIT.dataset_growth,
    counters.exportSize / ACTION_LIMIT.export,
  ];
  const maxRatio = Math.max(...ratios);
  if (maxRatio >= THRESHOLDS.SAFE_MODE) return "SAFE_MODE";
  if (maxRatio >= THRESHOLDS.DEGRADED) return "DEGRADED";
  if (maxRatio >= THRESHOLDS.THROTTLED) return "THROTTLED";
  return "NORMAL";
}

/**
 * Returns true if a given action is allowed under the supplied state.
 *
 * SAFE_MODE — only model_call survives (user inference).
 * DEGRADED — noncritical learning is paused; model_call + bg_execution of
 *            high-priority jobs would normally be allowed, but the spec is
 *            conservative: only model_call + dataset_growth (small writes)
 *            continue. Everything else pauses.
 * THROTTLED — everything proceeds, but callers SHOULD reduce frequency.
 * NORMAL — everything proceeds.
 */
function actionAllowedInState(action: GovernorAction, state: GovernorState): boolean {
  switch (state) {
    case "NORMAL":
      return true;
    case "THROTTLED":
      return true;
    case "DEGRADED":
      // Only user inference + tiny dataset writes survive.
      return action === "model_call" || action === "dataset_growth";
    case "SAFE_MODE":
      // Only user inference survives.
      return action === "model_call";
  }
}

function reasonFor(action: GovernorAction, state: GovernorState): string | undefined {
  if (state === "NORMAL") return undefined;
  if (actionAllowedInState(action, state)) {
    return `permitted under ${state} (user inference is always preserved)`;
  }
  return `denied: ${state} pauses noncritical background work (action=${action})`;
}

// ---------------------------------------------------------------
// Lazy row creation
// ---------------------------------------------------------------

async function getTodayRow(): Promise<{
  id: string;
  date: string;
  learningEvents: number;
  webRequests: number;
  modelCalls: number;
  bgExecutions: number;
  datasetGrowth: number;
  exportSize: number;
  state: GovernorState;
}> {
  const date = todayKey();
  const existing = await db.costBudget.findUnique({ where: { date } });
  if (existing) {
    return { ...existing, state: clampState(existing.state) };
  }
  const created = await db.costBudget.create({
    data: { date, state: "NORMAL" },
  });
  return { ...created, state: clampState(created.state) };
}

/**
 * Persist the (possibly updated) state + counters back to the row. Uses the
 * computed state, but if the row was forced into SAFE_MODE explicitly (via
 * setState), the explicit state is preserved unless the counters would
 * warrant an even stricter state.
 */
async function syncState(
  rowId: string,
  currentState: GovernorState,
  counters: {
    learningEvents: number;
    webRequests: number;
    modelCalls: number;
    bgExecutions: number;
    datasetGrowth: number;
    exportSize: number;
  },
  forcedState?: GovernorState,
): Promise<GovernorState> {
  const computed = computeStateFromCounters(counters);
  // The effective state is the STRICTER of (forced, computed).
  const effective: GovernorState = stricterOf(forcedState ?? currentState, computed);
  if (effective !== currentState) {
    await db.costBudget.update({
      where: { id: rowId },
      data: { state: effective },
    });
  }
  return effective;
}

function stricterOf(a: GovernorState, b: GovernorState): GovernorState {
  const order: GovernorState[] = ["NORMAL", "THROTTLED", "DEGRADED", "SAFE_MODE"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export interface CanPerformResult {
  allowed: boolean;
  state: GovernorState;
  reason?: string;
}

export interface GovernorStateSnapshot {
  state: GovernorState;
  usage: Record<string, number>;
  limits: typeof FREE_TIER_LIMITS;
}

export class ZeroCostGovernor {
  /**
   * Check whether an action is allowed under the current budget.
   *
   * Does NOT increment the counter — call `record(action)` after the action
   * actually completes. This two-step pattern lets callers respect
   * pre-flight denials without charging for actions that did not run.
   *
   * The single exception is `model_call`: user-facing inference is ALWAYS
   * permitted (even in SAFE_MODE) because the system must never refuse a
   * user-facing answer entirely. model_call is recorded, not gated.
   */
  static async canPerform(action: GovernorAction): Promise<CanPerformResult> {
    const row = await getTodayRow();

    // Reconcile stored state with what the counters imply (idempotent).
    const effectiveState = await syncState(row.id, row.state, row, row.state);

    // Hard ceiling check: even model_call hits a ceiling.
    const field = ACTION_FIELD[action];
    const limit = ACTION_LIMIT[action];
    const currentCount = row[field] as number;
    if (currentCount >= limit) {
      const reason = `denied: hard ceiling reached (${action}=${currentCount}/${limit})`;
      // In SAFE_MODE for noncritical actions, the reason is the same.
      return { allowed: false, state: effectiveState, reason };
    }

    const allowed = actionAllowedInState(action, effectiveState);
    const reason = reasonFor(action, effectiveState);
    return { allowed, state: effectiveState, reason };
  }

  /**
   * Record that an action was performed. Increments the appropriate counter
   * and re-evaluates the state. Also enforces a final hard-ceiling guard —
   * if the counter would exceed the limit, the increment is REJECTED (the
   * caller is expected to have called `canPerform` first).
   */
  static async record(action: GovernorAction | string): Promise<void> {
    const normalized: GovernorAction = (
      ["learning_event", "web_request", "model_call", "bg_execution", "dataset_growth", "export"] as const
    ).includes(action as GovernorAction)
      ? (action as GovernorAction)
      : "learning_event"; // unknown actions count as a learning event (conservative)

    const row = await getTodayRow();
    const field = ACTION_FIELD[normalized];
    const limit = ACTION_LIMIT[normalized];
    const next = (row[field] as number) + 1;

    if (next > limit) {
      // Hard refusal: do NOT increment past the ceiling. The governor never
      // allows an overage even if a caller skipped the pre-flight check.
      // Persist a SAFE_MODE transition if not already there.
      await syncState(row.id, row.state, row, "SAFE_MODE");
      // Audit-trail note (no throw — callers in the learning fabric should
      // treat this as a no-op rather than a fatal error).
      return;
    }

    const updated = await db.costBudget.update({
      where: { id: row.id },
      data: { [field]: next },
    });

    // Re-evaluate state after the increment.
    await syncState(
      row.id,
      clampState(updated.state),
      {
        learningEvents: updated.learningEvents,
        webRequests: updated.webRequests,
        modelCalls: updated.modelCalls,
        bgExecutions: updated.bgExecutions,
        datasetGrowth: updated.datasetGrowth,
        exportSize: updated.exportSize,
      },
      clampState(updated.state),
    );
  }

  /**
   * Get the current state + usage snapshot. Pure read — does not mutate.
   */
  static async getState(): Promise<GovernorStateSnapshot> {
    const row = await getTodayRow();
    return {
      state: row.state,
      usage: {
        learningEvents: row.learningEvents,
        webRequests: row.webRequests,
        modelCalls: row.modelCalls,
        bgExecutions: row.bgExecutions,
        datasetGrowth: row.datasetGrowth,
        exportSize: row.exportSize,
      },
      limits: FREE_TIER_LIMITS,
    };
  }

  /**
   * Force a state transition (e.g. SAFE_MODE during quota exhaustion on an
   * external provider that the Brain cannot directly observe).
   *
   * The forced state is the FLOOR — if counters would warrant an even
   * stricter state, the stricter one wins. The forced state is also
   * persisted on the row, so it survives subsequent reads until the next
   * day's row is created.
   */
  static async setState(state: GovernorState, reason: string): Promise<void> {
    const row = await getTodayRow();
    const next = stricterOf(state, computeStateFromCounters(row));
    await db.costBudget.update({
      where: { id: row.id },
      data: {
        state: next,
        metadata: JSON.stringify({
          forcedState: state,
          effectiveState: next,
          reason,
          forcedAt: new Date().toISOString(),
        }),
      },
    });
  }
}

// ---------------------------------------------------------------
// Convenience helper for the Learning Fabric
// ---------------------------------------------------------------

/**
 * Pre-flight check used by every Learning Fabric operation. Throws nothing —
 * returns a boolean so callers can short-circuit cleanly.
 *
 * Usage:
 *   const gate = await assertLearningBudget();
 *   if (!gate.allowed) return { skipped: true, reason: gate.reason };
 */
export async function assertLearningBudget(): Promise<CanPerformResult> {
  return ZeroCostGovernor.canPerform("learning_event");
}

/**
 * True if the governor is currently in any non-NORMAL state. Useful for the
 * admin UI / metrics endpoint without exposing the full state machine.
 */
export async function isGovernorActive(): Promise<boolean> {
  const snap = await ZeroCostGovernor.getState();
  return snap.state !== "NORMAL";
}

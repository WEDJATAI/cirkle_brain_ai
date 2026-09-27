// WEDJAT BRAIN V2 — Failure Taxonomy (spec Part 3).
//
// The 17 canonical failure types + the analysis pipeline that maps each
// failure to the smallest layer that should change (spec §3, §180).
//
// Design rules:
//   - Never escalate a layer change when a smaller one suffices
//     (smallest-first principle, §3).
//   - Each failure type has a deterministic layer + recommended action so
//     the Learning Fabric and audit log can reproduce every decision.
//   - The taxonomy is a SIGNAL layer — it does NOT mutate models, prompts,
//     policies, or trusted knowledge on its own (Rule 9, §97).
//
// Layer vocabulary (kept in sync with the LearningObservation + FailureRecord
// schemas — §88, §180):
//   knowledge | verification | retrieval | reranker | router | model | tools
//   context | prompts | policy | unknown

export const FAILURE_TYPES = [
  "WRONG_FACT",
  "OUTDATED_FACT",
  "UNSUPPORTED_CLAIM",
  "CONTRADICTION",
  "BAD_RETRIEVAL",
  "BAD_RERANKING",
  "BAD_MODEL_SELECTION",
  "TOOL_FAILURE",
  "TOOL_SELECTION_FAILURE",
  "CONTEXT_FAILURE",
  "INSTRUCTION_FAILURE",
  "FORMAT_FAILURE",
  "SAFETY_FAILURE",
  "USER_CORRECTION",
  "SOURCE_QUALITY_FAILURE",
  "REASONING_FAILURE",
  "UNKNOWN_RESULT",
] as const;

export type FailureType = (typeof FAILURE_TYPES)[number];

/**
 * Maps each failure type to the layer that should change.
 *
 * This is the "smallest layer" answer to "what should we fix?" for a given
 * failure class. Layers follow the Brain contract (§88): knowledge,
 * verification, retrieval, reranker, router, model, tools, context, prompts,
 * policy, unknown.
 */
export const FAILURE_LAYER_MAP: Record<FailureType, string> = {
  WRONG_FACT: "knowledge",
  OUTDATED_FACT: "knowledge",
  UNSUPPORTED_CLAIM: "verification",
  CONTRADICTION: "knowledge",
  BAD_RETRIEVAL: "retrieval",
  BAD_RERANKING: "reranker",
  BAD_MODEL_SELECTION: "router",
  TOOL_FAILURE: "tools",
  TOOL_SELECTION_FAILURE: "tools",
  CONTEXT_FAILURE: "context",
  INSTRUCTION_FAILURE: "prompts",
  FORMAT_FAILURE: "prompts",
  SAFETY_FAILURE: "policy",
  USER_CORRECTION: "knowledge",
  SOURCE_QUALITY_FAILURE: "knowledge",
  REASONING_FAILURE: "model",
  UNKNOWN_RESULT: "unknown",
};

/**
 * Recommended action per failure type. The action is a SIGNAL — it does not
 * perform the action itself; the Learning Fabric + Release Gate decide
 * whether and how to apply it.
 */
export const FAILURE_ACTION_MAP: Record<FailureType, string> = {
  WRONG_FACT:
    "Generate a knowledge candidate correcting the fact; quarantine the incorrect item pending review.",
  OUTDATED_FACT:
    "Mark the existing knowledge item for refresh; create a superseding candidate with updated content.",
  UNSUPPORTED_CLAIM:
    "Route the claim through Evidence Validator; reject promotion until ≥1 supporting evidence is attached.",
  CONTRADICTION:
    "Create a KnowledgeConflict record between the new candidate and the existing item; route to HUMAN_REVIEW.",
  BAD_RETRIEVAL:
    "Tune the retrieval scoring weights (semantic/keyword/structured) or extend the source corpus for this domain.",
  BAD_RERANKING:
    "Adjust the reranker feature weights; record an observation so the Reranker Learner can update insights.",
  BAD_MODEL_SELECTION:
    "Record a ModelUsage observation; re-run the Router Learner to update per-taskType model preferences.",
  TOOL_FAILURE:
    "Investigate the tool execution error; update the tool's input/output schema or disable the tool pending fix.",
  TOOL_SELECTION_FAILURE:
    "Adjust the tool planning rules so the correct tool is selected for this query class.",
  CONTEXT_FAILURE:
    "Increase context budget or improve context assembly prioritization for this task type.",
  INSTRUCTION_FAILURE:
    "Revise the prompt template (system / task-specific) to clarify instructions; bump promptVersion.",
  FORMAT_FAILURE:
    "Add explicit formatting constraints to the prompt; add a format-validation post-check.",
  SAFETY_FAILURE:
    "Escalate to policy review; tighten the data-class ceiling, provider allowlist, or human-approval threshold.",
  USER_CORRECTION:
    "Generate a knowledge candidate from the correction; the corrected text becomes the candidate content.",
  SOURCE_QUALITY_FAILURE:
    "Lower the source trustLevel; require additional evidence for any candidate that depends on this source.",
  REASONING_FAILURE:
    "Record the failure as a model benchmark signal; consider routing similar tasks to a higher-tier model.",
  UNKNOWN_RESULT:
    "Record the observation; defer until sufficient signal exists to classify the failure precisely.",
};

export type FailurePriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Priority by failure type. SAFETY_FAILURE is always CRITICAL; factual /
 * contradiction failures are HIGH; retrieval / router / format failures are
 * MEDIUM; the rest default to LOW. Override via context (e.g. a repeat
 * occurrence can be elevated).
 */
export const FAILURE_PRIORITY_MAP: Record<FailureType, FailurePriority> = {
  WRONG_FACT: "HIGH",
  OUTDATED_FACT: "MEDIUM",
  UNSUPPORTED_CLAIM: "MEDIUM",
  CONTRADICTION: "HIGH",
  BAD_RETRIEVAL: "MEDIUM",
  BAD_RERANKING: "LOW",
  BAD_MODEL_SELECTION: "MEDIUM",
  TOOL_FAILURE: "MEDIUM",
  TOOL_SELECTION_FAILURE: "MEDIUM",
  CONTEXT_FAILURE: "LOW",
  INSTRUCTION_FAILURE: "MEDIUM",
  FORMAT_FAILURE: "LOW",
  SAFETY_FAILURE: "CRITICAL",
  USER_CORRECTION: "MEDIUM",
  SOURCE_QUALITY_FAILURE: "MEDIUM",
  REASONING_FAILURE: "HIGH",
  UNKNOWN_RESULT: "LOW",
};

/**
 * Context-aware priority overrides. Recognized keys:
 *   - repeatCount: number of prior occurrences within the rolling window
 *   - userImpact: "low" | "medium" | "high" (downstream effect on user)
 *   - safetyAdjacent: boolean — true if the failure occurred near a safety-
 *     sensitive operation (tool execution, external action, judicial/finance)
 */
export interface FailureAnalysisContext {
  repeatCount?: number;
  userImpact?: "low" | "medium" | "high";
  safetyAdjacent?: boolean;
  [key: string]: unknown;
}

/**
 * Analyze a failure and recommend the smallest-layer change.
 *
 * Returns the target layer, the recommended action, and the priority. The
 * output is suitable for direct use as a FailureRecord and as input to the
 * Learning Fabric's curriculum builder.
 */
export function analyzeFailure(
  failureType: FailureType,
  context?: FailureAnalysisContext,
): {
  layer: string;
  recommendedAction: string;
  priority: FailurePriority;
} {
  const layer = FAILURE_LAYER_MAP[failureType];
  const recommendedAction = FAILURE_ACTION_MAP[failureType];
  let priority = FAILURE_PRIORITY_MAP[failureType];

  if (context) {
    // Elevate on repeat occurrences (3+ within the rolling window).
    const repeatCount = typeof context.repeatCount === "number" ? context.repeatCount : 0;
    if (repeatCount >= 3) {
      priority = elevate(priority);
    }
    // Elevate on high user impact.
    if (context.userImpact === "high") {
      priority = elevate(priority);
    }
    // Any safety-adjacent failure is at least HIGH.
    if (context.safetyAdjacent) {
      if (priority !== "CRITICAL") priority = elevate(priority);
      if (priority === "MEDIUM") priority = "HIGH";
    }
  }

  // Safety failures are always CRITICAL, regardless of context.
  if (failureType === "SAFETY_FAILURE") {
    priority = "CRITICAL";
  }

  return { layer, recommendedAction, priority };
}

function elevate(p: FailurePriority): FailurePriority {
  const order: FailurePriority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const idx = order.indexOf(p);
  return order[Math.min(idx + 1, order.length - 1)];
}

/**
 * Validate that a string is one of the canonical failure types.
 * Useful when ingesting failures from external/adapter events.
 */
export function isFailureType(s: string): s is FailureType {
  return (FAILURE_TYPES as readonly string[]).includes(s);
}

/**
 * Parse a string into a FailureType, falling back to UNKNOWN_RESULT.
 */
export function parseFailureType(s: string | null | undefined): FailureType {
  if (s && isFailureType(s)) return s;
  return "UNKNOWN_RESULT";
}

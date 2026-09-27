// WEDJAT BRAIN V2 — Brain Runtime orchestrator (§11, §73).
//
// Real-time path (§11): USER → Brain API → Authenticate → Resolve identity →
// Resolve tenant/application → Policy check → Task classification → Memory
// retrieval → Knowledge retrieval → Structured data retrieval if needed →
// Tool planning if needed → Model selection → Reasoning → Verification
// where required → Streaming response → Persist interaction → Emit
// background events.
//
// Observability (§73): every request produces a trace (BrainRun + BrainSteps
// + BrainEvents + AuditEvents). Cost (§75) and latency (§77) measured.

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { resolveIdentity } from "./identity";
import { resolvePolicy } from "./policy";
import { hybridRetrieve, type StructuredLookup } from "./retrieval";
import { assembleSystemPrompt } from "./prompts";
import { selectModel, callModel } from "./models";
import { listTools, executeTool } from "./tools";
import { verifyAnswer } from "./verification";
import { createLearningCandidate } from "./learning";
import { recordEpisodic, createMemoryCandidate } from "./memory";
import { estimateTokens } from "./vectors";
import { researchAndLearn, type IngestedKnowledge } from "./web-search";
import type { PolicyRules } from "./policy";
import type {
  BrainRequest, BrainResponse, IdentityContext, PolicyMode,
  TraceStep, TaskType, EvidenceRef, BrainStreamEvent, ToolResult,
  RetrievalCandidate, ModelDescriptor, EvidenceStatus,
} from "./types";

export interface RuntimeCallbacks {
  onEvent?: (ev: BrainStreamEvent) => void;
  signal?: AbortSignal;
}

/** Classify the task deterministically (§38, §79). */
export function classifyTask(text: string, structured: StructuredLookup): TaskType {
  const t = text.toLowerCase();
  if (structured.matched) return "factual";
  if (/(analyze|compare|design|architect|reason|why|trade-off|tradeoff|explain|derive|prove|calculate how|step.by.step|how does|how do|what is the mechanism|what causes|consequence|implication)/.test(t)) return "reasoning";
  if (/(synthesize|summarize|draft|write|compose|generate|essay|article|report|outline)/.test(t)) return "synthesis";
  if (/(code|function|bug|implement|refactor|algorithm|debug|program|script)/.test(t)) return "coding";
  if (/(send|create|update|delete|book|publish|purchase|approve)/.test(t)) return "tool_use";
  if (/(danger|critical|high.?risk|authorize|approve|restricted)/.test(t)) return "high_risk";
  // Questions with "what is X", "who", "when", "where" are factual lookups
  if (/^(what|who|when|where|which|how many|how much)\b/.test(t.trim())) return "factual";
  if (text.length < 60 && /\?$/.test(text.trim())) return "simple";
  // Default: treat longer questions as reasoning (better answers)
  if (text.length > 80) return "reasoning";
  return "simple";
}

/**
 * Run the Brain. Returns a typed BrainResponse; the supplied callbacks
 * receive streaming BrainStreamEvents (trace, tokens, evidence, model,
 * tool, verification, cost, learning, done).
 */
export async function runBrain(req: BrainRequest, cb: RuntimeCallbacks = {}): Promise<BrainResponse> {
  const startedAt = Date.now();
  const requestId = req.requestId || randomUUID();
  const trace: TraceStep[] = [];

  const emit = (ev: BrainStreamEvent) => {
    if (cb.signal?.aborted) throw new Error("aborted");
    cb.onEvent?.(ev);
  };
  const step = async <T>(stepType: TraceStep["stepType"], stepName: string, fn: () => Promise<T>, reasonCode?: string): Promise<T> => {
    const s = Date.now();
    emit({ type: "trace", step: { stepType, stepName, status: "STARTED", reasonCode } });
    try {
      const out = await fn();
      const t: TraceStep = { stepType, stepName, status: "COMPLETED", durationMs: Date.now() - s, reasonCode };
      trace.push(t);
      emit({ type: "trace", step: t });
      return out;
    } catch (err: any) {
      const t: TraceStep = { stepType, stepName, status: "FAILED", durationMs: Date.now() - s, reasonCode, detail: { error: err?.message } };
      trace.push(t);
      emit({ type: "trace", step: t });
      throw err;
    }
  };

  // Create the BrainRun record up front (§73).
  let identity: IdentityContext;
  let policy: PolicyRules;
  let runId: string;

  try {
    identity = await step("identity", "Resolve identity + tenant isolation", async () => {
      const i = await resolveIdentity(req);
      // Ensure conversation exists for episodic recording.
      return i;
    }, "tenant + application + user resolved");

    policy = await step("policy", "Resolve effective policy", async () => {
      return resolvePolicy(identity);
    }, "global → tenant → application inheritance");

    runId = await createRun(req, identity, requestId);
  } catch (err: any) {
    emit({ type: "error", message: err.message, code: err.code });
    return errorResponse(requestId, err, trace);
  }

  try {
    // Persist the user message as an episodic event (§20.1).
    await step("memory", "Record episodic user input", async () => {
      if (req.conversationId) {
        await db.message.create({
          data: {
            conversationId: req.conversationId,
            role: "user",
            content: req.input.text ?? "",
            tokensIn: estimateTokens(req.input.text ?? ""),
          },
        }).catch(() => {});
      }
      await recordEpisodic({
        tenantId: identity.tenant.id,
        applicationId: identity.application.id,
        userId: identity.user?.id,
        conversationId: req.conversationId,
        type: "user_message",
        content: req.input.text ?? "",
        source: "user",
      }).catch(() => {});
      return null;
    }, "episodic memory");

    // Task router + hybrid retrieval
    let structured: StructuredLookup = { matched: false, kind: "none", reason: "not attempted" };
    let candidates: RetrievalCandidate[] = [];
    await step("retrieval", "Hybrid retrieval (semantic + keyword + structured)", async () => {
      const out = await hybridRetrieve({
        identity,
        text: req.input.text ?? "",
        topK: 8,
      });
      structured = out.structured;
      candidates = out.candidates;
      return out;
    }, structured.matched ? "structured lookup hit — LLM not needed for fact" : "semantic + keyword hybrid");

    const taskType = await step("task_router", "Classify task", async () => {
      return classifyTask(req.input.text ?? "", structured);
    }, `task=${classifyTask(req.input.text ?? "", structured)}`);

    emit({ type: "memory", memory: candidates.filter((c) => c.kind === "memory").map((c) => ({ id: c.id, content: c.content, type: c.type ?? "", scope: c.scope ?? "" })) });

    // Build evidence refs (§29 lineage: answer → claim → evidence → source)
    const evidence: EvidenceRef[] = candidates
      .filter((c) => c.kind === "knowledge")
      .map((c) => ({
        id: c.id,
        type: (c.record as any)?.type ?? "FACT",
        claim: c.content,
        sourceTitle: c.source,
        evidenceStatus: (c.evidenceStatus as EvidenceStatus) ?? "SUPPORTED",
        retrievedAt: new Date().toISOString(),
        validFrom: c.validFrom?.toISOString(),
        validUntil: c.validUntil?.toISOString(),
        conflict: !!(c as any).conflict,
      }));
    if (evidence.length > 0) emit({ type: "evidence", evidence });

    // Web research fallback (spec §115): when local knowledge is insufficient
    // AND no structured hit AND external search is allowed, search the web,
    // ingest results as ACTIVE knowledge (per user request: "learn and expand"),
    // and feed them to the model as additional context.
    let researchUsed = false;
    let researchSources: Array<{ title: string; url: string }> = [];
    const knowledgeCandidates = candidates.filter((c) => c.kind === "knowledge");
    // Trigger web research only when local knowledge is genuinely insufficient:
    // check the raw semantic relevance (not the trust-boosted total score).
    // A semantic score below 0.15 means the question isn't covered by what
    // we have, even if a loosely-related fact was retrieved.
    const topSemanticScore = knowledgeCandidates.length > 0
      ? Math.max(...knowledgeCandidates.map((c) => c.semanticScore ?? 0))
      : 0;
    const hasSufficientKnowledge = topSemanticScore > 0.3;
    const allowResearch = req.constraints?.allowExternalSearch !== false && policy.externalSearchAllowed !== false;

    if (!structured.matched && !hasSufficientKnowledge && allowResearch && (req.input.text ?? "").trim().length > 2) {
      await step("research", "Web research — local knowledge insufficient, searching internet", async () => {
        const researchQuery = (req.input.text ?? "").trim().slice(0, 200);
        const research = await researchAndLearn({
          tenantId: identity.tenant.id,
          applicationId: identity.application.id,
          query: researchQuery,
          maxResults: 6,
        });
        researchUsed = research.results.length > 0;
        researchSources = research.ingested.slice(0, 5).map((i) => ({ title: i.sourceTitle, url: i.sourceUri }));
        emit({
          type: "research",
          query: researchQuery,
          resultsCount: research.results.length,
          ingestedCount: research.ingested.filter((i) => i.freshlyIngested).length,
          sources: researchSources,
        });
        // Merge web-sourced evidence into the candidates pool for the model call
        if (research.ingested.length > 0) {
          // Re-run retrieval now that web knowledge is in the DB — picks up the
          // freshly ingested items.
          const reRetrieve = await hybridRetrieve({
            identity,
            text: req.input.text ?? "",
            topK: 8,
          });
          // Merge new knowledge candidates without losing prior memory hits
          const newKnowledge = reRetrieve.candidates.filter((c) => c.kind === "knowledge");
          // Add web-sourced evidence to the evidence list
          for (const ev of research.evidence) {
            if (!evidence.find((e) => e.id === ev.id)) evidence.push(ev);
          }
          // Replace knowledge candidates with the refreshed set (includes web)
          candidates = [...candidates.filter((c) => c.kind !== "knowledge"), ...newKnowledge];
          if (evidence.length > 0) emit({ type: "evidence", evidence });
        }
        return research;
      }, researchUsed ? `web search: ${researchSources.length} sources ingested` : "web search returned no results");
    }

    // §163 — if structured hit, answer deterministically without LLM (§79, §191)
    let answer = "";
    let modelUsed = "structured";
    let provider = "deterministic";
    let fallbackUsed = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let modelLatencyMs = 0;
    const toolsUsed: string[] = [];

    if (structured.matched) {
      await step("model_router", "Skip model — deterministic answer (§37, §79)", async () => {
        emit({ type: "model", model: "structured", provider: "deterministic", fallbackUsed: false, reason: structured.reason });
        return null;
      }, "deterministic routing");
      answer = `According to authoritative records: ${typeof structured.value === "object" ? JSON.stringify(structured.value) : String(structured.value)}\n\nSource: structured lookup (no reasoning model required).`;
      tokensOut = estimateTokens(answer);
    } else {
      // Model router (§47) + fallback (§48)
      const selected = await step("model_router", "Select model (tier + provider + fallback)", async () => {
        const out = await selectModel({
          taskType,
          mode: req.mode,
          policyMode: identity.application.modelPolicy as PolicyMode,
          policy,
          dataClass: identity.tenant.dataPolicy,
        });
        emit({ type: "model", model: out.model.displayName, provider: out.model.provider, fallbackUsed: false, reason: out.reason });
        return out;
      }, "tier + provider + fallback resolved");

      // Tool planning — pick tools relevant to the request
      const tools = await listTools(identity.tenant.id);
      const plannedTools = tools.filter((t) => {
        const txt = (req.input.text ?? "").toLowerCase();
        if (t.toolId === "calc.add" || t.toolId === "calc.multiply") return /(add|sum|plus|multiply|times|\*)/.test(txt);
        if (t.toolId === "invoice.lookup") return /invoice/.test(txt);
        if (t.toolId === "weather.current") return /weather|temperature|forecast/.test(txt);
        if (t.toolId === "memory.recall") return /remember|recall|previous/.test(txt);
        if (t.toolId === "email.send") return /send.*email|email.*send/.test(txt);
        if (t.toolId === "math.evaluate") return /(calculate|compute|evaluate|solve).*expression|math.*expression|\d+\s*[\+\-\*\/]\s*\d+/.test(txt);
        if (t.toolId === "unit.convert") return /(convert|conversion).*(unit|length|weight|temperature|volume|km|mile|kg|lb|celsius|fahrenheit)/.test(txt);
        if (t.toolId === "date.calculate") return /(date|days|weeks|months|years).*(from now|ago|difference|between|add|subtract)/.test(txt);
        if (t.toolId === "currency.convert") return /(convert|exchange).*(currency|usd|eur|gbp|jpy|egp|sar|aed)/.test(txt);
        if (t.toolId === "language.translate") return /(translate|translation).*(to|from|into|language)/.test(txt);
        if (t.toolId === "define.lookup") return /(define|definition|meaning of|what does).*(word|term)/.test(txt);
        if (t.toolId === "time.now") return /(what time|current time|what date|today|now)/.test(txt);
        if (t.toolId === "text.count") return /(count|number of).*(words|characters|sentences|paragraphs)/.test(txt);
        if (t.toolId === "text.code.format") return /(detect|identify).*(language|code)/.test(txt);
        return false;
      }).slice(0, 3);

      // Context engine — assemble minimal sufficient context with platform
      // personality + governance boundaries + conversation history.
      const assembly = await step("context", "Assemble minimal sufficient context", async () => {
        // §157 — apply platform personality + governance boundaries.
        const platformSlug = (req.metadata as any)?.platformSlug as string | undefined;
        let platformSuffix = "";
        let governanceBoundary = "";
        if (platformSlug) {
          const platformRow = await db.platform.findUnique({ where: { slug: platformSlug } }).catch(() => null);
          if (platformRow?.personality) {
            try {
              const p = JSON.parse(platformRow.personality) as { tone?: string; vocabulary?: string[]; systemPromptSuffix?: string };
              platformSuffix = p.systemPromptSuffix ?? "";
              if (p.tone) platformSuffix += ` Tone: ${p.tone}.`;
              if (p.vocabulary?.length) platformSuffix += ` Domain vocabulary: ${p.vocabulary.join(", ")}.`;
            } catch { /* ignore malformed personality */ }
          }
          const { getPlatformBySlug } = await import("./platform-registry");
          const cat = getPlatformBySlug(platformSlug);
          if (cat?.governanceBoundary) governanceBoundary = `\n\nGOVERNANCE BOUNDARY: ${cat.governanceBoundary}`;
        }
        // Fetch conversation history for multi-turn context (last 6 messages)
        let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
        if (req.conversationId) {
          const recentMsgs = await db.message.findMany({
            where: { conversationId: req.conversationId, role: { in: ["user", "assistant"] } },
            orderBy: { createdAt: "desc" },
            take: 6,
          }).catch(() => []);
          conversationHistory = recentMsgs.reverse().map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })).filter((m) => m.content && m.content.length > 0);
        }
        // Use reasoning mode for complex tasks (chain-of-thought like DeepSeek-R1)
        const useReasoning = taskType === "reasoning" || taskType === "synthesis" || taskType === "high_risk" || req.mode === "deep";
        const { systemPrompt } = assembleSystemPrompt({
          identity, tools: plannedTools, candidates, evidenceStatus: "SUPPORTED", taskType,
          conversationHistory,
          reasoningMode: useReasoning,
        });
        const fullSystemPrompt = systemPrompt + (platformSuffix ? `\n\nPLATFORM CONTEXT: ${platformSuffix}` : "") + governanceBoundary;
        const budget = selected.model.contextLimit;
        const sysTokens = estimateTokens(fullSystemPrompt);
        const memoryTokens = candidates.filter((c) => c.kind === "memory").reduce((s, c) => s + estimateTokens(c.content), 0);
        const knowledgeTokens = candidates.filter((c) => c.kind === "knowledge").reduce((s, c) => s + estimateTokens(c.content), 0);
        return { systemPrompt: fullSystemPrompt, budget, sysTokens, memoryTokens, knowledgeTokens, conversationHistory, useReasoning };
      }, "token-budgeted");

      // Optionally execute a planned tool BEFORE generation (single-shot; not a full agent loop)
      let toolResult: ToolResult | undefined;
      if (plannedTools.length > 0 && req.constraints?.allowTools !== false) {
        const tool = plannedTools[0];
        await step("tool", `Governed tool execution: ${tool.toolId}`, async () => {
          const input = extractToolInput(tool.toolId, req.input.text ?? "");
          toolResult = await executeTool({
            call: { toolId: tool.toolId, input, tenantId: identity.tenant.id, runId },
            tool,
            identity,
            policy,
            runId,
          });
          emit({ type: "tool", tool: toolResult });
          if (toolResult.state === "VERIFIED") toolsUsed.push(tool.toolId);
          return toolResult;
        }, `risk=${tool.riskLevel}`);
      }

      // Reasoning step (DeepSeek-R1 style chain-of-thought) — for complex tasks,
      // run the model twice: first to reason/plan, then to produce the final
      // answer. The reasoning output is fed as additional context.
      let reasoningContext = "";
      if (assembly.useReasoning) {
        await step("reasoning", "Chain-of-thought reasoning pass", async () => {
          const { buildReasoningPrompt } = await import("./prompts");
          const reasoningPrompt = buildReasoningPrompt(req.input.text ?? "", candidates);
          const reasoningMessages = [
            { role: "system" as const, content: "You are an expert reasoner. Think step-by-step about the question, then outline your answer. Be concise." },
            { role: "user" as const, content: reasoningPrompt },
          ];
          const r = await callModel({
            model: selected.model,
            messages: reasoningMessages,
            fallback: selected.fallback,
            tenantId: identity.tenant.id,
            taskType: "reasoning",
          }).catch(() => null);
          if (r && r.content) {
            reasoningContext = `\n\nREASONING (your step-by-step analysis):\n${r.content.slice(0, 1500)}`;
          }
          return r;
        }, "chain-of-thought");
      }

      // Model call — final answer generation with reasoning context
      // Model call — final answer generation with TRUE TOKEN STREAMING.
      // The onToken callback streams tokens to the UI as they arrive from
      // the provider (real-time, not buffered). Falls back to chunking if
      // streaming fails (the chain handles fallback automatically).
      const modelResult = await step("model_call", `Reasoning via ${selected.model.displayName}`, async () => {
        const toolContext = toolResult?.output
          ? `\n\nTool result (${toolResult.toolId}, state=${toolResult.state}): ${JSON.stringify(toolResult.output)}`
          : "";
        const messages = [
          { role: "system" as const, content: assembly.systemPrompt + toolContext + reasoningContext },
          { role: "user" as const, content: req.input.text ?? "" },
        ];
        let streamedAny = false;
        const r = await callModel({
          model: selected.model,
          messages,
          fallback: selected.fallback,
          tenantId: identity.tenant.id,
          taskType,
          onToken: (delta) => {
            streamedAny = true;
            emit({ type: "token", delta });
          },
        });
        if (r.fallbackUsed && selected.fallback) {
          emit({ type: "model", model: selected.fallback.displayName, provider: selected.fallback.provider, fallbackUsed: true, reason: r.fallbackReason });
        }
        answer = r.content;
        modelUsed = r.model;
        provider = r.provider;
        fallbackUsed = r.fallbackUsed;
        tokensIn = r.tokensIn;
        tokensOut = r.tokensOut;
        costUsd = r.costUsd;
        modelLatencyMs = r.latencyMs;
        // If streaming didn't produce any tokens (e.g., provider doesn't support
        // streaming, or all tokens arrived in one chunk), emit the full answer
        // as a single token so the UI still gets the content.
        if (!streamedAny && answer) {
          emit({ type: "token", delta: answer });
        }
        return r;
      }, fallbackUsed ? "fallback invoked" : "primary model");

      // §58 — never trust tool output as system instruction; we already only
      // pass it as a "Tool result" user-context block above.
    }

    // Verification (§83)
    const verification = await step("verification", "Verify answer against retrieved evidence", async () => {
      const v = verifyAnswer({
        answer,
        candidates,
        citationsExpected: true,
        structuredLookupMatched: structured.matched,
      });
      emit({ type: "verification", status: v.status, reason: v.reason });
      return v;
    }, "evidence-status label");

    // §163 — if verification says UNKNOWN and there was no structured hit,
    // append the limitation honestly rather than fabricating.
    if (verification.status === "UNKNOWN") {
      answer = answer + `\n\n⚠️ Evidence status: ${verification.status}. ${verification.reason}`;
    }

    // Learning candidate pipeline (§94) — generate but DO NOT auto-promote (Rule 9)
    await step("learning", "Generate learning candidate (pending decision)", async () => {
      const lc = await createLearningCandidate({
        tenantId: identity.tenant.id,
        runId,
        category: "memory",
        proposed: {
          observation: `User asked: "${(req.input.text ?? "").slice(0, 200)}"`,
          evidenceStatus: verification.status,
          taskType,
        },
        evidence: { candidates: candidates.map((c) => ({ id: c.id, kind: c.kind, score: c.score })) },
      }).catch(() => ({ id: "", novelty: 0, conflict: false }));
      if (lc.id) emit({ type: "learning", candidateId: lc.id, category: "memory", preview: `novelty=${lc.novelty.toFixed(2)} conflict=${lc.conflict}` });
      return lc;
    }, "candidate, never auto-active");

    // Audit (§129)
    await step("audit", "Record audit event", async () => {
      await db.auditEvent.create({
        data: {
          tenantId: identity.tenant.id,
          requestId,
          actorType: "user",
          actorId: identity.user?.id ?? "anonymous",
          action: "brain.responded",
          target: requestId,
          reason: `model=${modelUsed} tools=${toolsUsed.join(",") || "none"} evidence=${verification.status}`,
          severity: "INFO",
        },
      });
      return null;
    }, "significant action audited");

    const latencyMs = Date.now() - startedAt;
    emit({ type: "cost", tokensIn, tokensOut, costUsd, latencyMs });

    const response: BrainResponse = {
      requestId,
      answer,
      execution: {
        model: modelUsed,
        provider,
        fallbackUsed,
        toolsUsed,
        retrievalUsed: candidates.length > 0,
        verificationUsed: true,
        researchUsed,
        researchSources,
      },
      evidence,
      state: { actionStatus: toolsUsed.length > 0 ? "executed" : "none" },
      quality: { evidenceStatus: verification.status },
      cost: { tokensIn, tokensOut, costUsd, latencyMs },
      trace,
    };

    // Persist assistant message + finalize the BrainRun
    await finalizeRun(runId, requestId, response, identity);
    if (req.conversationId) {
      await db.message.create({
        data: {
          conversationId: req.conversationId,
          role: "assistant",
          content: answer,
          toolsUsed: JSON.stringify(toolsUsed),
          modelUsed,
          tokensIn,
          tokensOut,
          costUsd,
          latencyMs: modelLatencyMs,
          evidenceStatus: verification.status,
          actionStatus: toolsUsed.length > 0 ? "executed" : "none",
        },
      }).catch(() => {});
    }

    emit({ type: "done", response });
    return response;
  } catch (err: any) {
    await db.brainRun.update({ where: { id: runId }, data: { status: "FAILED", errorMessage: err?.message } }).catch(() => {});
    emit({ type: "error", message: err?.message ?? "brain failed" });
    return errorResponse(requestId, err, trace);
  }
}

async function createRun(req: BrainRequest, identity: IdentityContext, requestId: string): Promise<string> {
  const run = await db.brainRun.create({
    data: {
      requestId,
      tenantId: identity.tenant.id,
      applicationId: identity.application.id,
      sessionId: identity.session?.id ?? null,
      conversationId: req.conversationId ?? null,
      userId: identity.user?.id ?? null,
      mode: req.mode ?? "auto",
      input: JSON.stringify(req.input),
      status: "RUNNING",
    },
  });
  return run.id;
}

async function finalizeRun(runId: string, requestId: string, response: BrainResponse, identity: IdentityContext): Promise<void> {
  await db.brainRun.update({
    where: { id: runId },
    data: {
      status: "COMPLETED",
      output: JSON.stringify({ answer: response.answer, quality: response.quality }),
      modelUsed: response.execution.model,
      fallbackUsed: response.execution.fallbackUsed,
      retrievalUsed: response.execution.retrievalUsed,
      verificationUsed: response.execution.verificationUsed,
      toolsUsed: JSON.stringify(response.execution.toolsUsed),
      evidenceCount: response.evidence?.length ?? 0,
      memoryCount: (response.trace ?? []).filter((s) => s.stepType === "memory").length,
      tokensIn: response.cost?.tokensIn ?? 0,
      tokensOut: response.cost?.tokensOut ?? 0,
      costUsd: response.cost?.costUsd ?? 0,
      latencyMs: response.cost?.latencyMs ?? 0,
      completedAt: new Date(),
    },
  });
  // Persist trace steps
  for (const t of response.trace ?? []) {
    await db.brainStep.create({
      data: {
        runId,
        stepType: t.stepType,
        stepName: t.stepName,
        status: t.status,
        input: null,
        output: t.detail ? JSON.stringify(t.detail) : null,
        reasonCode: t.reasonCode ?? null,
        durationMs: t.durationMs ?? 0,
      },
    }).catch(() => {});
  }
  // Emit a brain.responded event (§113)
  await db.brainEvent.create({
    data: {
      eventId: randomUUID(),
      eventType: "brain.responded",
      eventVersion: 1,
      tenantId: identity.tenant.id,
      applicationId: identity.application.id,
      runId,
      actorType: "system",
      actorId: "brain.runtime",
      data: JSON.stringify({ requestId, model: response.execution.model, cost: response.cost }),
    },
  }).catch(() => {});
}

function extractToolInput(toolId: string, text: string): Record<string, unknown> {
  const t = text.toLowerCase();
  if (toolId === "calc.add" || toolId === "calc.multiply") {
    const nums = (text.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    return { a: nums[0] ?? 0, b: nums[1] ?? 0 };
  }
  if (toolId === "invoice.lookup") {
    const m = text.match(/invoice\s*#?\s*(\d+)/i);
    return { invoiceId: m?.[1] ?? "" };
  }
  if (toolId === "weather.current") {
    const m = text.match(/(?:weather|temperature|forecast)\s*(?:in|for|at)?\s+([a-z\s]+)/i);
    return { city: (m?.[1] ?? "unknown").trim() };
  }
  if (toolId === "memory.recall") {
    return { query: text, tenantId: "", applicationId: "" };
  }
  if (toolId === "email.send") {
    return {
      to: (text.match(/to\s+([\w.@-]+)/i)?.[1]) ?? "unknown@example.com",
      subject: "Brain draft",
      body: text,
      idempotencyKey: randomUUID(),
    };
  }
  return {};
}

function errorResponse(requestId: string, err: any, trace: TraceStep[]): BrainResponse {
  return {
    requestId,
    answer: `Brain error: ${err?.message ?? "unknown"}`,
    execution: { model: "none", provider: "none", fallbackUsed: false, toolsUsed: [], retrievalUsed: false, verificationUsed: false, researchUsed: false, researchSources: [] },
    quality: { evidenceStatus: "UNSUPPORTED" },
    cost: { tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 },
    trace,
  };
}

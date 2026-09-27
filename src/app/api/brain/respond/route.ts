// POST /api/brain/respond — streaming Brain response (§13).
//
// Streams BrainStreamEvent objects as newline-delimited JSON. The final event
// is `{ type: "done", response: BrainResponse }`.
//
// PERFORMANCE: checks LRU response cache first. On hit, streams the cached
// answer instantly (no model call, no retrieval, no tool execution).
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { runBrain } from "@/lib/brain/runtime";
import { seedBrain } from "@/lib/brain/seed";
import { db } from "@/lib/db";
import type { BrainRequest, BrainStreamEvent } from "@/lib/brain/types";
import { buildCacheKey, getCachedResponse, setCachedResponse } from "@/lib/brain/response-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function ensureSeed() {
  const tenantCount = await db.tenant.count();
  if (tenantCount === 0) {
    await seedBrain();
  }
}

export async function POST(req: NextRequest) {
  await ensureSeed();
  const body = (await req.json()) as Partial<BrainRequest>;
  const requestId = body.requestId || randomUUID();

  // Resolve tenant/application/user defaults so the widget works out-of-box.
  const tenant = await resolveDefaultTenant();
  const application = await resolveDefaultApplication(tenant.id);
  const user = await resolveDefaultUser(tenant.id);

  // ─── LRU response cache check ───────────────────────────────────────────
  // If the same query was asked recently (within 30 min), return the cached
  // answer instantly — no model call, no retrieval, no tool execution.
  const inputText = body.input?.text ?? "";
  const cacheKey = buildCacheKey({
    tenantId: tenant.id,
    applicationId: application.id,
    mode: body.mode,
    inputText,
  });
  const cached = getCachedResponse(cacheKey);

  // Ensure conversation exists for episodic recording.
  let conversationId = body.conversationId;
  if (!conversationId) {
    const conv = await db.conversation.create({
      data: {
        tenantId: tenant.id,
        applicationId: application.id,
        sessionId: (await db.session.create({ data: { tenantId: tenant.id, applicationId: application.id, userId: user?.id, externalRef: body.sessionId } })).id,
        userId: user?.id,
        title: inputText.slice(0, 80),
      },
    });
    conversationId = conv.id;
  }

  // ─── Cache HIT: stream the cached answer instantly ──────────────────────
  if (cached) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (ev: BrainStreamEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        };
        try {
          // Emit a cache-hit trace + the cached answer tokens + done
          send({ type: "trace", step: { stepType: "cache", stepName: "LRU cache hit — returning cached answer", status: "COMPLETED", durationMs: 0, reasonCode: `cached ${cached.hitCount}x, age=${Math.round((Date.now() - cached.cachedAt) / 1000)}s` } });
          send({ type: "model", model: "(cached)", provider: "cache", fallbackUsed: false, reason: "LRU cache hit — no model call needed" });
          // Stream the cached answer in chunks (same as live response)
          const chunks = cached.answer.match(/[^.!?]+[.!?]?\s*/g) ?? [cached.answer];
          for (const c of chunks) send({ type: "token", delta: c });
          if (cached.evidence && cached.evidence.length > 0) {
            send({ type: "evidence", evidence: cached.evidence });
          }
          send({ type: "cost", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - (cached.cachedAt - cached.latencyMs) });
          send({ type: "done", response: { ...cached.response, requestId } });
        } catch (err: any) {
          send({ type: "error", message: err?.message ?? "cache stream failed" });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Cirkle-Cache": "HIT",
      },
    });
  }

  const brainReq: BrainRequest = {
    requestId,
    tenantId: tenant.id,
    applicationId: application.id,
    userId: user?.id,
    sessionId: body.sessionId,
    conversationId,
    input: { text: inputText },
    mode: body.mode ?? "auto",
    permissions: { scopes: user?.scopes?.split(",") ?? ["brain:respond"] },
    constraints: body.constraints,
    metadata: { ...body.metadata, platformSlug: (body as any).platformSlug ?? "mashahd" },
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (ev: BrainStreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      };
      try {
        const response = await runBrain(brainReq, { onEvent: send });
        // ─── Cache the successful response for future hits ──────────────
        if (response.answer && response.answer.length > 0) {
          setCachedResponse(cacheKey, {
            answer: response.answer,
            response,
            evidence: response.evidence,
            tokensIn: response.cost?.tokensIn ?? 0,
            tokensOut: response.cost?.tokensOut ?? 0,
            costUsd: response.cost?.costUsd ?? 0,
            latencyMs: response.cost?.latencyMs ?? 0,
          });
        }
      } catch (err: any) {
        send({ type: "error", message: err?.message ?? "brain failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Cirkle-Cache": "MISS",
    },
  });
}

async function resolveDefaultTenant() {
  let t = await db.tenant.findUnique({ where: { slug: "acme" } });
  if (!t) {
    await seedBrain();
    t = await db.tenant.findUnique({ where: { slug: "acme" } });
  }
  return t!;
}

async function resolveDefaultApplication(tenantId: string) {
  const a = await db.application.findFirst({ where: { tenantId, slug: "mashahd" } });
  return a!;
}

async function resolveDefaultUser(tenantId: string) {
  const u = await db.user.findFirst({ where: { tenantId, email: "alice@acme.test" } });
  return u;
}

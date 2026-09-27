// POST /api/brain/feedback — record user feedback (thumbs up/down/correction)
// and generate a learning candidate from it.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createLearningCandidate } from "@/lib/brain/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    requestId?: string;
    messageId?: string;
    signal: "thumbs_up" | "thumbs_down" | "correction" | "edit" | "retry" | "regenerate";
    content?: string;
    tenantId?: string;
    userId?: string;
    answer?: string; // the answer being rated
    question?: string; // the question that was asked
  };

  if (!body.signal) {
    return NextResponse.json({ error: "signal required" }, { status: 400 });
  }

  // Resolve defaults
  let tenantId = body.tenantId;
  let userId = body.userId;
  if (!tenantId) {
    const t = await db.tenant.findUnique({ where: { slug: "acme" } }) ?? (await db.tenant.findFirst())!;
    tenantId = t.id;
  }
  if (!userId) {
    const u = await db.user.findFirst({ where: { tenantId } });
    userId = u?.id;
  }

  // Create the Feedback record
  const feedback = await db.feedback.create({
    data: {
      tenantId,
      userId: userId ?? null,
      requestId: body.requestId ?? null,
      messageId: body.messageId ?? null,
      signal: body.signal,
      content: body.content ?? null,
    },
  });

  // For thumbs_down / correction / retry → generate a learning candidate
  // so the Brain can learn from negative feedback
  if (body.signal === "thumbs_down" || body.signal === "correction" || body.signal === "retry") {
    try {
      await createLearningCandidate({
        tenantId,
        runId: body.requestId,
        category: "memory",
        proposed: {
          feedback: body.signal,
          question: body.question?.slice(0, 500),
          answer: body.answer?.slice(0, 500),
          correction: body.content?.slice(0, 500),
          note: "User indicated the answer was unsatisfactory. Investigate retrieval quality, model selection, or knowledge gaps.",
        },
        evidence: { feedbackId: feedback.id },
      });
    } catch (e) {
      // Don't fail the feedback if the learning candidate fails
    }
  }

  // For thumbs_up → also create a candidate (positive reinforcement signal)
  if (body.signal === "thumbs_up") {
    try {
      await createLearningCandidate({
        tenantId,
        runId: body.requestId,
        category: "memory",
        proposed: {
          feedback: "thumbs_up",
          question: body.question?.slice(0, 500),
          answer: body.answer?.slice(0, 500),
          note: "User found this answer helpful. Reinforce the retrieval + model path that produced it.",
        },
        evidence: { feedbackId: feedback.id },
      });
    } catch (e) {
      // ignore
    }
  }

  return NextResponse.json({ ok: true, feedbackId: feedback.id });
}

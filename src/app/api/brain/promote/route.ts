// POST /api/brain/promote — run promotion pipeline on pending candidates
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { limit?: number; candidateId?: string };
  const { db } = await import("@/lib/db");
  const { runPromotionPipeline } = await import("@/lib/brain/learning-fabric");

  if (body.candidateId) {
    // Promote a single candidate
    const result = await runPromotionPipeline(body.candidateId);
    return NextResponse.json({ result });
  }

  // Promote batch of pending candidates
  const limit = Math.min(body.limit ?? 10, 50);
  const candidates = await db.learningCandidate.findMany({
    where: { decision: "PENDING" },
    orderBy: { noveltyScore: "desc" },
    take: limit,
  });

  const results: Array<{ candidateId: string; decision: string; reason: string }> = [];
  let promoted = 0, rejected = 0, deferred = 0;

  for (const c of candidates) {
    try {
      const result = await runPromotionPipeline(c.id);
      results.push({
        candidateId: c.id,
        decision: result.decision,
        reason: result.reason,
      });
      if (result.decision === "PROMOTED") promoted++;
      else if (result.decision === "REJECTED") rejected++;
      else deferred++;
    } catch (e: any) {
      results.push({ candidateId: c.id, decision: "ERROR", reason: e?.message ?? "unknown" });
    }
  }

  return NextResponse.json({
    total: candidates.length,
    promoted,
    rejected,
    deferred,
    results: results.slice(0, 20),
  });
}

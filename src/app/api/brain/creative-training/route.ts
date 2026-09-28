// POST /api/brain/creative-training — run creative training modules
// (adversarial self-training + cross-domain synthesis + market data fetch)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestCrossDomainSynthesis } from "@/lib/brain/cross-domain-synthesis";
import { fetchAndIngestMarketData } from "@/lib/brain/market-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const moduleName = body.module || "all"; // "synthesis" | "market" | "all"

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) {
    return NextResponse.json({ error: "tenant/application not found" }, { status: 500 });
  }

  const results: any = { module: moduleName, timestamp: new Date().toISOString() };

  if (moduleName === "synthesis" || moduleName === "all") {
    try {
      const synth = await ingestCrossDomainSynthesis(tenant.id, application.id);
      results.crossDomainSynthesis = synth;
    } catch (err: any) {
      results.crossDomainSynthesis = { error: err?.message };
    }
  }

  if (moduleName === "market" || moduleName === "all") {
    try {
      const market = await fetchAndIngestMarketData(tenant.id, application.id);
      results.marketData = {
        indicators: market.indicators.length,
        ingested: market.ingested,
        details: market.indicators.map(i => ({ name: i.name, value: i.value, unit: i.unit })),
      };
    } catch (err: any) {
      results.marketData = { error: err?.message };
    }
  }

  // Final knowledge count
  results.totalKnowledge = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });

  return NextResponse.json(results);
}

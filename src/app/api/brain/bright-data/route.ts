// GET  /api/brain/bright-data — check if Bright Data is enabled + fetch snapshot
// POST /api/brain/bright-data — trigger a scrape for a URL
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const snapshotId = req.nextUrl.searchParams.get("snapshot");
  if (snapshotId) {
    // Fetch a specific snapshot
    const { fetchSnapshot } = await import("@/lib/brain/bright-data");
    const snapshot = await fetchSnapshot(snapshotId);
    if (!snapshot) {
      return NextResponse.json({ error: "snapshot not found or Bright Data not enabled" }, { status: 404 });
    }
    return NextResponse.json({
      url: snapshot.url,
      title: snapshot.pageTitle,
      contentLength: snapshot.markdown.length,
      contentPreview: snapshot.markdown.slice(0, 500),
      timestamp: snapshot.timestamp,
    });
  }
  // Status check
  const { isBrightDataEnabled } = await import("@/lib/brain/bright-data");
  const enabled = isBrightDataEnabled();
  return NextResponse.json({
    enabled,
    message: enabled
      ? "Bright Data enhanced web research is active. Full page content (markdown) will be used for web research."
      : "Bright Data is disabled. The Brain falls back to z-ai web_search (snippet-only). Set BRIGHTDATA_ENABLED=true to enable.",
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { url: string; snapshotId?: string };

  if (body.snapshotId) {
    // Fetch existing snapshot
    const { fetchSnapshot } = await import("@/lib/brain/bright-data");
    const snapshot = await fetchSnapshot(body.snapshotId);
    if (!snapshot) {
      return NextResponse.json({ error: "snapshot not found" }, { status: 404 });
    }
    return NextResponse.json({
      url: snapshot.url,
      title: snapshot.pageTitle,
      content: snapshot.markdown.slice(0, 2000),
      contentLength: snapshot.markdown.length,
      timestamp: snapshot.timestamp,
    });
  }

  if (body.url) {
    // Scrape a URL
    const { scrapeUrl } = await import("@/lib/brain/bright-data");
    const result = await scrapeUrl(body.url);
    if (!result) {
      return NextResponse.json({ error: "scrape failed — Bright Data not enabled or URL blocked" }, { status: 502 });
    }
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "url or snapshotId required" }, { status: 400 });
}

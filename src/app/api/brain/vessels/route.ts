// GET /api/brain/vessels — query live vessel tracking data
//
// Query parameters:
//   ?name=<partial>   — search vessels by name (case-insensitive)
//   ?mmsi=<number>    — look up vessel by MMSI
//   ?type=<type>      — filter by ship type (Cargo, Tanker, Passenger, etc.)
//   ?limit=<n>        — max results (default 20, max 100)
//
// Returns JSON array of vessel positions from the knowledge base.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name");
  const mmsi = searchParams.get("mmsi");
  const type = searchParams.get("type");
  const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 100);

  // Build query — all vessels come from the "AIS Live Vessel Tracking" source
  const source = await db.knowledgeSource.findFirst({
    where: { title: "AIS Live Vessel Tracking — Real-Time Positions" },
    select: { id: true },
  });

  if (!source) {
    return NextResponse.json({ error: "AIS vessel tracking source not found. Run AIS collection first." }, { status: 404 });
  }

  const where: any = { sourceId: source.id, status: "ACTIVE" };

  if (name) {
    where.claim = { contains: name, };
  }

  if (mmsi) {
    where.content = { contains: `MMSI: ${mmsi}` };
  }

  if (type) {
    where.content = { ...where.content, contains: `Type: ${type}` };
  }

  const items = await db.knowledgeItem.findMany({
    where,
    orderBy: { lastRefreshedAt: "desc" },
    take: limit,
    select: { id: true, claim: true, content: true, confidence: true, lastRefreshedAt: true },
  });

  // Parse vessel data from content
  const vessels = items.map(item => {
    const content = item.content;
    const mmsiMatch = content.match(/MMSI: (\d+)/);
    const imoMatch = content.match(/IMO: (\d+)/);
    const nameMatch = content.match(/Vessel Name: (.+?)\./);
    const posMatch = content.match(/Position: ([\d.-]+), ([\d.-]+)/);
    const sogMatch = content.match(/Speed: ([\d.]+) knots/);
    const cogMatch = content.match(/Course: (\d+)/);
    const typeMatch = content.match(/Type: (.+?)\./);
    const destMatch = content.match(/Destination: (.+?)\./);
    const callSignMatch = content.match(/CallSign: (.+?)\./);
    const msgsMatch = content.match(/Messages: (\d+)/);

    return {
      id: item.id,
      mmsi: mmsiMatch ? parseInt(mmsiMatch[1]) : null,
      imo: imoMatch ? parseInt(imoMatch[1]) : null,
      name: nameMatch ? nameMatch[1].trim() : null,
      latitude: posMatch ? parseFloat(posMatch[1]) : null,
      longitude: posMatch ? parseFloat(posMatch[2]) : null,
      speed: sogMatch ? parseFloat(sogMatch[1]) : null,
      course: cogMatch ? parseInt(cogMatch[1]) : null,
      shipType: typeMatch ? typeMatch[1].trim() : null,
      destination: destMatch ? destMatch[1].trim() : null,
      callSign: callSignMatch ? callSignMatch[1].trim() : null,
      messages: msgsMatch ? parseInt(msgsMatch[1]) : null,
      confidence: item.confidence,
      lastRefreshedAt: item.lastRefreshedAt,
    };
  });

  return NextResponse.json({
    count: vessels.length,
    source: "AIS Stream API (aisstream.io) — REAL-TIME",
    lastCollection: items[0]?.lastRefreshedAt || null,
    vessels,
  });
}

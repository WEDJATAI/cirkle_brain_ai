// Cirkle Brain AI — AIS Stream Data Collection + Knowledge Ingestion
//
// Connects to the AIS Stream API WebSocket, collects real vessel position
// data for 60 seconds, and ingests the collected vessels into the Brain's
// knowledge base. This makes the Brain a LIVE vessel tracking platform.
//
// Run: AIS_STREAM_API_KEY=b64bab18... npx tsx scripts/collect-ais-data.ts

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";
import WebSocket from "ws";

const AIS_API_KEY = process.env.AIS_STREAM_API_KEY || "b64bab18c2aa9c1a943e4f9d55f22f194d2745fe";
const WS_URL = "wss://stream.aisstream.io/v0/stream";
const COLLECTION_DURATION_MS = 30000; // 30 seconds

interface CollectedVessel {
  mmsi: number;
  imo?: number;
  shipName?: string;
  latitude: number;
  longitude: number;
  sog?: number;
  cog?: number;
  heading?: number;
  navStatus?: string;
  destination?: string;
  eta?: string;
  shipType?: string;
  callSign?: string;
  draught?: number;
  firstSeen: number;
  lastSeen: number;
  messageCount: number;
}

const vessels = new Map<number, CollectedVessel>();

function mapShipType(type: number | string): string {
  const t = typeof type === "string" ? parseInt(type) : type;
  const types: Record<number, string> = {
    0: "Not available", 20: "Wing in ground", 30: "Fishing", 31: "Towing",
    32: "Towing (large)", 33: "Dredging", 34: "Diving", 35: "Military",
    36: "Sailing", 37: "Pleasure craft", 40: "High-speed craft",
    50: "Pilot vessel", 51: "Search and rescue", 52: "Tug", 53: "Port tender",
    54: "Anti-pollution", 55: "Law enforcement", 58: "Medical transport",
    59: "Noncombatant", 60: "Passenger", 70: "Cargo",
    71: "Cargo — hazardous A", 72: "Cargo — hazardous B",
    73: "Cargo — hazardous C", 74: "Cargo — hazardous D",
    80: "Tanker", 81: "Tanker — hazardous A", 82: "Tanker — hazardous B",
    83: "Tanker — hazardous C", 84: "Tanker — hazardous D", 90: "Other",
  };
  return types[t] ?? `Type ${t}`;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  AIS Stream Data Collection + Knowledge Ingestion           ║");
  console.log("║  (Collecting REAL vessel positions via WebSocket)            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) {
    console.error("ERROR: Could not find default tenant/application");
    process.exit(1);
  }

  // Create knowledge source for live vessel data
  let source = await db.knowledgeSource.findFirst({
    where: { tenantId: tenant.id, title: "AIS Live Vessel Tracking — Real-Time Positions" },
  });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: {
        tenantId: tenant.id,
        sourceType: "web",
        title: "AIS Live Vessel Tracking — Real-Time Positions",
        author: "AIS Stream API (aisstream.io)",
        trustLevel: "VERIFIED",
        verificationStatus: "VERIFIED",
        dataClassification: "PUBLIC",
      },
    });
    console.log(`✓ Created AIS vessel tracking knowledge source\n`);
  }

  console.log(`Connecting to AIS Stream API: ${WS_URL}`);
  console.log(`API Key: ${AIS_API_KEY.slice(0, 8)}...${AIS_API_KEY.slice(-4)}\n`);

  return new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    let messageCount = 0;
    let positionCount = 0;
    let staticCount = 0;

    ws.on("open", () => {
      console.log("✓ WebSocket connected — subscribing to worldwide vessel positions\n");
      // Subscribe to worldwide AIS data
      const subscription = {
        Apikey: AIS_API_KEY,
        PeriodicInterval: 0,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterShipTypes: [],
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      };
      ws.send(JSON.stringify(subscription));
      console.log(`Collecting vessel data for ${COLLECTION_DURATION_MS / 1000} seconds...\n`);

      // Stop after collection duration
      setTimeout(async () => {
        console.log(`\n=== Collection complete ===`);
        console.log(`  Messages received: ${messageCount}`);
        console.log(`  Position reports: ${positionCount}`);
        console.log(`  Static data reports: ${staticCount}`);
        console.log(`  Unique vessels tracked: ${vessels.size}\n`);

        ws.close();

        // Ingest collected vessels into Neon
        console.log("=== Ingesting vessel data into Neon Postgres ===\n");
        let ingested = 0;
        let updated = 0;

        const vesselList = Array.from(vessels.values()).sort((a, b) => b.messageCount - a.messageCount);

        for (const v of vesselList) {
          const content = `LIVE AIS VESSEL TRACKING DATA:
MMSI: ${v.mmsi}
${v.imo ? `IMO: ${v.imo}\n` : ""}${v.shipName ? `Vessel Name: ${v.shipName}\n` : ""}${v.callSign ? `Call Sign: ${v.callSign}\n` : ""}Position: ${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}
${v.sog !== undefined ? `Speed: ${v.sog.toFixed(1)} knots\n` : ""}${v.cog !== undefined ? `Course: ${v.cog.toFixed(0)}°\n` : ""}${v.heading !== undefined ? `Heading: ${v.heading.toFixed(0)}°\n` : ""}${v.navStatus ? `Navigation Status: ${v.navStatus}\n` : ""}${v.shipType ? `Ship Type: ${v.shipType}\n` : ""}${v.destination ? `Destination: ${v.destination}\n` : ""}${v.eta ? `ETA: ${v.eta}\n` : ""}${v.draught !== undefined ? `Draught: ${v.draught}m\n` : ""}Last Seen: ${new Date(v.lastSeen).toISOString()}
Messages Received: ${v.messageCount}
Data Source: AIS Stream API (aisstream.io) — REAL-TIME`;

          const claim = v.shipName
            ? `Vessel "${v.shipName}" (MMSI ${v.mmsi}) — live position ${v.latitude.toFixed(2)},${v.longitude.toFixed(2)}`
            : `Vessel MMSI ${v.mmsi} — live position ${v.latitude.toFixed(2)},${v.longitude.toFixed(2)}`;

          // Check if a vessel with this MMSI was already tracked
          const existing = await db.knowledgeItem.findFirst({
            where: {
              tenantId: tenant.id,
              sourceId: source.id,
              claim: { startsWith: `Vessel` },
              content: { contains: `MMSI: ${v.mmsi}` },
            },
          });

          if (existing) {
            // Update the existing vessel's position (live data changes)
            await db.knowledgeItem.update({
              where: { id: existing.id },
              data: {
                claim,
                content,
                contentVector: serializeVector(buildTermVector(claim + " " + content + " vessel AIS tracking")),
                lastRefreshedAt: new Date(),
                validFrom: new Date(),
              },
            });
            updated++;
          } else {
            await db.knowledgeItem.create({
              data: {
                tenantId: tenant.id,
                applicationId: application.id,
                sourceId: source.id,
                type: "OBSERVATION",
                scope: "APPLICATION",
                claim,
                content,
                contentVector: serializeVector(buildTermVector(claim + " " + content + " vessel AIS tracking")),
                status: "ACTIVE",
                confidence: 0.95, // very high — live verified data
                validFrom: new Date(),
                refreshSchedule: "hourly",
                lastRefreshedAt: new Date(),
              },
            });
            ingested++;
          }
        }

        console.log(`  ✓ New vessels ingested: ${ingested}`);
        console.log(`  ✓ Existing vessels updated: ${updated}`);
        console.log(`  Total vessels in knowledge base: ${ingested + updated}\n`);

        // Print summary of tracked vessels
        console.log("=== Tracked Vessels Summary ===\n");
        const byType = new Map<string, number>();
        for (const v of vesselList) {
          const type = v.shipType || "Unknown";
          byType.set(type, (byType.get(type) ?? 0) + 1);
        }
        console.log("By ship type:");
        for (const [type, count] of Array.from(byType.entries()).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${type}: ${count}`);
        }

        // Show top 10 most-tracked vessels
        console.log("\nTop 10 vessels (by message count):");
        for (const v of vesselList.slice(0, 10)) {
          const name = v.shipName || "(unknown)";
          const type = v.shipType || "Unknown";
          console.log(`  ${name.padEnd(25)} MMSI ${String(v.mmsi).padEnd(10)} ${type.padEnd(15)} (${v.latitude.toFixed(2)}, ${v.longitude.toFixed(2)}) msgs=${v.messageCount}`);
        }

        // Audit
        await db.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actorType: "system",
            actorId: "brain.ais-collection",
            action: "knowledge.ais_vessels_ingested",
            target: source.id,
            reason: `Collected ${vessels.size} live vessels via AIS Stream API (${messageCount} messages, ${positionCount} positions, ${staticCount} static). Ingested ${ingested} new, updated ${updated}.`,
            severity: "INFO",
          },
        }).catch(() => {});

        const finalCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  AIS COLLECTION + INGESTION COMPLETE                        ║`);
        console.log(`║  Vessels tracked: ${vessels.size}                                        ║`);
        console.log(`║  New items ingested: ${ingested}                                    ║`);
        console.log(`║  Existing items updated: ${updated}                                  ║`);
        console.log(`║  Total ACTIVE knowledge: ${finalCount}                              ║`);
        console.log(`╚══════════════════════════════════════════════════════════════╝`);

        await db.$disconnect();
        resolve();
      }, COLLECTION_DURATION_MS);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      messageCount++;
      try {
        const msg = JSON.parse(data.toString()) as any;
        const messageType = msg.MessageType;
        const metaData = msg.MetaData || {};
        const message = msg.Message || msg;

        if (messageType === "PositionReport") {
          positionCount++;
          const pos = message.PositionReport || message;
          const mmsi = metaData.MMSI ?? pos.MMSI ?? 0;
          if (!mmsi) return;

          // AIS Stream API puts ship name + position in MetaData
          const lat = metaData.latitude ?? pos.Latitude ?? 0;
          const lon = metaData.longitude ?? pos.Longitude ?? 0;
          const shipName = metaData.ShipName?.trim() || undefined;

          let vessel = vessels.get(mmsi);
          if (!vessel) {
            vessel = {
              mmsi,
              latitude: lat,
              longitude: lon,
              shipName,
              sog: pos.Sog, cog: pos.Cog, heading: pos.TrueHeading,
              navStatus: pos.NavigationStatus,
              firstSeen: Date.now(), lastSeen: Date.now(), messageCount: 0,
            };
            vessels.set(mmsi, vessel);
          } else {
            vessel.latitude = lat;
            vessel.longitude = lon;
            if (shipName) vessel.shipName = shipName;
            vessel.sog = pos.Sog ?? vessel.sog;
            vessel.cog = pos.Cog ?? vessel.cog;
            vessel.heading = pos.TrueHeading ?? vessel.heading;
            vessel.navStatus = pos.NavigationStatus ?? vessel.navStatus;
            vessel.lastSeen = Date.now();
          }
          vessel.messageCount++;

          if (messageCount % 200 === 0) {
            process.stdout.write(`\r  Received ${messageCount} messages, tracking ${vessels.size} vessels...`);
          }
        } else if (messageType === "ShipStaticData") {
          staticCount++;
          const sd = message.ShipStaticData || message;
          const mmsi = metaData.MMSI ?? sd.MMSI ?? 0;
          if (!mmsi) return;

          let vessel = vessels.get(mmsi);
          if (!vessel) {
            vessel = {
              mmsi,
              latitude: metaData.latitude ?? 0,
              longitude: metaData.longitude ?? 0,
              firstSeen: Date.now(), lastSeen: Date.now(), messageCount: 0,
            };
            vessels.set(mmsi, vessel);
          }
          if (sd.ImoNumber) vessel.imo = sd.ImoNumber;
          if (sd.ShipName) vessel.shipName = sd.ShipName.trim();
          else if (metaData.ShipName) vessel.shipName = metaData.ShipName.trim();
          if (sd.Type !== undefined) vessel.shipType = mapShipType(sd.Type);
          if (sd.CallSign) vessel.callSign = sd.CallSign.trim();
          if (sd.Destination) vessel.destination = sd.Destination.trim();
          if (sd.Eta) vessel.eta = sd.Eta;
          if (sd.Draught !== undefined) vessel.draught = sd.Draught;
          vessel.lastSeen = Date.now();
        }
      } catch {
        // Skip unparseable messages
      }
    });

    ws.on("error", (err: Error) => {
      console.error("\n❌ WebSocket error:", err.message);
      resolve();
    });

    ws.on("close", () => {
      console.log("\nWebSocket closed");
    });
  });
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});

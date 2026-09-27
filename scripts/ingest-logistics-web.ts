// Quick logistics ingestion — web-based sources only (no CSV parsing)
// Runs: sea ports, shipping lines, routes, AIS knowledge
import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";

async function main() {
  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) { console.error("no tenant/app"); process.exit(1); }

  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();

  function strip(html: string) { return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g," ").replace(/\s+/g, " ").trim(); }
  function chunk(text: string, max = 500): string[] {
    if (text.length <= max) return [text];
    const chunks: string[] = []; let cur = "";
    for (const s of text.match(/[^.!?]+[.!?]?\s*/g) ?? [text]) {
      if ((cur + s).length > max) { if (cur) chunks.push(cur.trim()); cur = s; } else cur += s;
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.filter(c => c.length > 20);
  }

  async function ensureSource(title: string, author: string) {
    let s = await db.knowledgeSource.findFirst({ where: { tenantId: tenant.id, title } });
    if (!s) s = await db.knowledgeSource.create({ data: { tenantId: tenant.id, sourceType: "web", title, author, trustLevel: "VERIFIED", verificationStatus: "VERIFIED", dataClassification: "PUBLIC" } });
    return s;
  }

  async function ingestFromUrls(sourceTitle: string, author: string, topic: string, urls: string[], extraItems: Array<{claim:string;content:string}> = []) {
    const source = await ensureSource(sourceTitle, author);
    const items: Array<{claim:string;content:string}> = [...extraItems];
    for (const url of urls) {
      try {
        const result = await zai.functions.invoke("page_reader", { url }) as any;
        const text = strip(result?.data?.html ?? "");
        if (text.length > 200) {
          const title = result?.data?.title ?? url;
          const chunks = chunk(text.slice(0, 8000), 500);
          for (let i = 0; i < chunks.length; i++) items.push({ claim: `${sourceTitle.split("—")[0].trim()} — ${title} (part ${i+1})`, content: chunks[i] });
          console.log(`    ✓ ${url.split("/").pop()?.slice(0,40)} (${text.length} chars, ${chunks.length} chunks)`);
        }
      } catch { console.log(`    ✗ ${url.split("/").pop()?.slice(0,40)}`); }
    }
    let ingested = 0;
    for (const item of items) {
      const existing = await db.knowledgeItem.findFirst({ where: { tenantId: tenant.id, sourceId: source.id, content: item.content } });
      if (existing) continue;
      await db.knowledgeItem.create({ data: { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "FACT", scope: "APPLICATION", claim: item.claim, content: item.content, contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " " + topic)), status: "ACTIVE", confidence: 0.85, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() } });
      ingested++;
    }
    console.log(`  ✓ ${sourceTitle}: ${ingested} new items (from ${urls.length} URLs + ${extraItems.length} extra)`);
    return ingested;
  }

  let total = 0;

  console.log("\n━━━ 2. SEA PORTS ━━━");
  total += await ingestFromUrls(
    "World Sea Ports — Busiest Container Ports",
    "Cirkle Brain (web-sourced)",
    "sea ports container terminals logistics shipping",
    [
      "https://en.wikipedia.org/wiki/List_of_world%27s_busiest_ports",
      "https://en.wikipedia.org/wiki/List_of_busiest_container_ports",
      "https://en.wikipedia.org/wiki/Port",
      "https://en.wikipedia.org/wiki/Container_terminal",
      "https://en.wikipedia.org/wiki/Port_of_Shanghai",
      "https://en.wikipedia.org/wiki/Port_of_Singapore",
      "https://en.wikipedia.org/wiki/Port_of_Rotterdam",
      "https://en.wikipedia.org/wiki/Port_of_Los_Angeles",
      "https://en.wikipedia.org/wiki/Port_of_Hamburg",
      "https://en.wikipedia.org/wiki/Port_of_Dubai",
      "https://en.wikipedia.org/wiki/Port_Said",
      "https://en.wikipedia.org/wiki/Sokhna_Port",
    ],
  );

  console.log("\n━━━ 3. SHIPPING LINES ━━━");
  total += await ingestFromUrls(
    "World Shipping Lines — Major Container Companies",
    "Cirkle Brain (web-sourced)",
    "shipping lines container companies maritime logistics",
    [
      "https://en.wikipedia.org/wiki/List_of_largest_container_shipping_companies",
      "https://en.wikipedia.org/wiki/Maersk",
      "https://en.wikipedia.org/wiki/Mediterranean_Shipping_Company",
      "https://en.wikipedia.org/wiki/CMA_CGM",
      "https://en.wikipedia.org/wiki/COSCO",
      "https://en.wikipedia.org/wiki/Hapag-Lloyd",
      "https://en.wikipedia.org/wiki/Ocean_Network_Express",
      "https://en.wikipedia.org/wiki/Evergreen_Marine",
      "https://en.wikipedia.org/wiki/Yang_Ming_Marine_Transport_Corp.",
      "https://en.wikipedia.org/wiki/ZIM_(shipping_company)",
    ],
  );

  console.log("\n━━━ 4. SEA FREIGHT ROUTES ━━━");
  total += await ingestFromUrls(
    "Sea Freight Routes — Trade Lanes and Canals",
    "Cirkle Brain (web-sourced)",
    "sea freight routes trade lanes shipping canals straits",
    [
      "https://en.wikipedia.org/wiki/Trade_route",
      "https://en.wikipedia.org/wiki/Suez_Canal",
      "https://en.wikipedia.org/wiki/Panama_Canal",
      "https://en.wikipedia.org/wiki/Strait_of_Malacca",
      "https://en.wikipedia.org/wiki/Bab-el-Mandeb",
      "https://en.wikipedia.org/wiki/Strait_of_Hormuz",
      "https://en.wikipedia.org/wiki/Cape_of_Good_Hope",
      "https://en.wikipedia.org/wiki/Trans-Siberian_Railway",
    ],
  );

  console.log("\n━━━ 5. AIS VESSEL TRACKING ━━━");
  total += await ingestFromUrls(
    "AIS — Automatic Identification System for Vessel Tracking",
    "Cirkle Brain (web-sourced + AIS Stream API)",
    "AIS vessel tracking maritime shipping MMSI IMO",
    [
      "https://en.wikipedia.org/wiki/Automatic_identification_system",
      "https://en.wikipedia.org/wiki/Maritime_Mobile_Service_Identity",
      "https://en.wikipedia.org/wiki/IMO_number",
      "https://en.wikipedia.org/wiki/Vessel_traffic_service",
    ],
    [{
      claim: "AIS Stream API — real-time vessel tracking via WebSocket",
      content: `AIS Stream API (https://aisstream.io/) provides real-time AIS vessel position data via WebSocket.
Connection: wss://stream.aisstream.io/v0/stream
Authentication: API key in subscription message
Subscription format: {"Apikey":"<key>","PeriodicInterval":0,"BoundingBoxes":[[[-90,-180],[90,180]]],"FilterMessageTypes":["PositionReport","ShipStaticData"]}
PositionReport fields: MMSI, Latitude, Longitude, Sog (speed over ground), Cog (course over ground), TrueHeading, NavigationStatus
ShipStaticData fields: MMSI, ImoNumber, ShipName, Type, CallSign, Destination, Eta, Draught, Dimension
MMSI: Maritime Mobile Service Identity — 9-digit unique vessel identifier
IMO number: 7-digit International Maritime Organization ship identifier
Ship types: 30=Fishing, 70=Cargo, 80=Tanker, 60=Passenger, 52=Tug, 35=Military
The AIS Stream API key is configured in .env as AIS_STREAM_API_KEY.
Integration: src/lib/brain/ais-stream.ts — startAisStream(), getVesselByMmsi(), searchVesselsByName()`,
    }],
  );

  // Audit
  await db.auditEvent.create({ data: { tenantId: tenant.id, actorType: "system", actorId: "brain.logistics-ingestion", action: "knowledge.ingested_logistics_web", target: "knowledge-base", reason: `Ingested ${total} logistics knowledge items (sea ports + shipping lines + routes + AIS)`, severity: "INFO" } }).catch(() => {});

  const finalCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  LOGISTICS INGESTION COMPLETE                        ║`);
  console.log(`║  New items this run: ${total}                              ║`);
  console.log(`║  Total ACTIVE knowledge: ${finalCount}                    ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

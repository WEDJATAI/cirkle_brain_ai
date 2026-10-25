// Cirkle Brain AI — Arabic Language + Handwriting Recognition Knowledge Ingestion
//
// Downloads + ingests knowledge about Arabic reading, Arabic handwriting
// recognition, Arabic OCR, Arabic calligraphy, and Arabic script
// characteristics. This trains the Brain on Arabic NLP + document processing.
//
// Sources: Wikipedia (authoritative articles on Arabic language + script + OCR)

import { db } from "../src/lib/db";
import { buildTermVector, serializeVector } from "../src/lib/brain/vectors";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");

function strip(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function chunk(text: string, max = 500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = []; let cur = "";
  for (const s of text.match(/[^.!?]+[.!?]?\s*/g) ?? [text]) {
    if ((cur + s).length > max) { if (cur) chunks.push(cur.trim()); cur = s; } else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(c => c.length > 20);
}

async function ensureSource(tenantId: string, title: string, author: string, classification = "PUBLIC") {
  let s = await db.knowledgeSource.findFirst({ where: { tenantId, title } });
  if (!s) {
    s = await db.knowledgeSource.create({ data: { tenantId, sourceType: "web", title, author, trustLevel: "VERIFIED", verificationStatus: "VERIFIED", dataClassification: classification } });
  }
  return s;
}

async function ingestItems(tenantId: string, applicationId: string, sourceId: string, topic: string, items: Array<{claim: string; content: string}>, confidence = 0.85) {
  let ingested = 0;
  for (const item of items) {
    const existing = await db.knowledgeItem.findFirst({ where: { tenantId, sourceId, content: item.content } });
    if (existing) continue;
    await db.knowledgeItem.create({
      data: { tenantId, applicationId, sourceId, type: "FACT", scope: "APPLICATION", claim: item.claim, content: item.content,
        contentVector: serializeVector(buildTermVector(item.claim + " " + item.content + " " + topic)),
        status: "ACTIVE", confidence, validFrom: new Date(), refreshSchedule: "manual", lastRefreshedAt: new Date() }
    });
    ingested++;
  }
  return ingested;
}

async function fetchFromUrls(urls: string[], sourceTitle: string): Promise<Array<{claim: string; content: string}>> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  const items: Array<{claim: string; content: string}> = [];
  for (const url of urls) {
    try {
      const result = await zai.functions.invoke("page_reader", { url }) as any;
      const text = strip(result?.data?.html ?? "").slice(0, 10000);
      if (text.length < 200) continue;
      const title = result?.data?.title ?? url;
      const chunks = chunk(text, 500);
      for (let i = 0; i < chunks.length; i++) {
        items.push({ claim: `${sourceTitle.split("—")[0].trim()} — ${title} (part ${i+1})`, content: chunks[i] });
      }
      console.log(`    ✓ ${url.split("/").pop()?.slice(0,40)} (${text.length} chars, ${chunks.length} chunks)`);
    } catch { console.log(`    ✗ ${url.split("/").pop()?.slice(0,40)}`); }
  }
  return items;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Arabic Language + Handwriting Recognition Ingestion        ║");
  console.log("║  + Fresh AIS Vessel Data Refresh                             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const application = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !application) { console.error("no tenant/app"); process.exit(1); }

  let total = 0;

  // ─── 1. ARABIC SCRIPT + LANGUAGE ─────────────────────────────────────
  console.log("━━━ 1. ARABIC SCRIPT + LANGUAGE ━━━");
  {
    const source = await ensureSource(tenant.id, "Arabic Script + Language — Reading and Writing", "Wikipedia (Arabic language + script)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Arabic_script",
      "https://en.wikipedia.org/wiki/Arabic_language",
      "https://en.wikipedia.org/wiki/Arabic_alphabet",
      "https://en.wikipedia.org/wiki/Arabic_diacritics",
      "https://en.wikipedia.org/wiki/Hamza",
      "https://en.wikipedia.org/wiki/Tashkil",
      "https://en.wikipedia.org/wiki/Arabic_numerals",
      "https://en.wikipedia.org/wiki/Right-to-left_script",
    ], "Arabic Script + Language");
    const n = await ingestItems(tenant.id, application.id, source.id, "Arabic script language alphabet reading writing RTL diacritics", items);
    console.log(`  ✓ Ingested ${n} Arabic script knowledge items\n`);
    total += n;
  }

  // ─── 2. ARABIC CALLIGRAPHY + HANDWRITING STYLES ─────────────────────
  console.log("━━━ 2. ARABIC CALLIGRAPHY + HANDWRITING STYLES ━━━");
  {
    const source = await ensureSource(tenant.id, "Arabic Calligraphy + Handwriting Styles — Kufic, Naskh, Ruqah, Diwani", "Wikipedia (Arabic calligraphy)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Arabic_calligraphy",
      "https://en.wikipedia.org/wiki/Kufic",
      "https://en.wikipedia.org/wiki/Naskh_(script)",
      "https://en.wikipedia.org/wiki/Ruq%27ah",
      "https://en.wikipedia.org/wiki/Diwani",
      "https://en.wikipedia.org/wiki/Thuluth",
      "https://en.wikipedia.org/wiki/Magribi_script",
      "https://en.wikipedia.org/wiki/Nastaliq",
    ], "Arabic Calligraphy + Handwriting");
    const n = await ingestItems(tenant.id, application.id, source.id, "Arabic calligraphy handwriting Kufic Naskh Ruqah Diwani Thuluth script styles", items);
    console.log(`  ✓ Ingested ${n} Arabic calligraphy knowledge items\n`);
    total += n;
  }

  // ─── 3. ARABIC OCR + TEXT RECOGNITION ───────────────────────────────
  console.log("━━━ 3. ARABIC OCR + TEXT RECOGNITION ━━━");
  {
    const source = await ensureSource(tenant.id, "Arabic OCR + Text Recognition — Optical Character Recognition for Arabic", "Wikipedia (OCR + Arabic NLP)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Optical_character_recognition",
      "https://en.wikipedia.org/wiki/Arabic_natural_language_processing",
      "https://en.wikipedia.org/wiki/Tesseract_(software)",
      "https://en.wikipedia.org/wiki/Handwriting_recognition",
      "https://en.wikipedia.org/wiki/Intelligent_character_recognition",
      "https://en.wikipedia.org/wiki/Document_layout_analysis",
    ], "Arabic OCR Text Recognition");
    // Add domain-specific knowledge about Arabic OCR challenges
    items.push({
      claim: "Arabic OCR challenges — connected letters, right-to-left, diacritics",
      content: `ARABIC OCR CHALLENGES:
1. Connected letters: Arabic letters change shape based on position (initial, medial, final, isolated). This makes segmentation harder than Latin scripts.
2. Right-to-left (RTL): Arabic text flows right-to-left, requiring bidirectional text processing.
3. Diacritics (Tashkil): Optional vowel marks (harakat) that can be present or absent, affecting recognition.
4. Ligatures: Arabic letters connect to each other, creating ligatures that must be recognized as units.
5. Multiple writing styles: Naskh, Ruqah, Kufic, Diwani, Thuluth — each has different letter shapes.
6. No uppercase/lowercase distinction: Arabic has no case, but letters have positional variants.
7. Dot patterns: Many Arabic letters share the same base shape but differ in dot placement (ب ت ث ن ي).
8. Numbers: Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) differ from Western Arabic numerals (0-9).

ARABIC OCR TECHNIQUES:
- Segmentation: connected-component analysis to separate letters
- Feature extraction: stroke direction, dot patterns, ligature detection
- Deep learning: CNN + LSTM (CRNN) for sequence-to-sequence recognition
- HMM-based: Hidden Markov Models for handwritten Arabic text
- Tesseract OCR: supports Arabic via traineddata (ara.traineddata)
- Google Vision API: supports Arabic text detection
- Preprocessing: binarization, deskewing, noise removal, line segmentation

ARABIC HANDWRITING RECOGNITION:
- IFN/ENIT dataset: 32,000 handwritten Arabic word images (Tunisian city names)
- KHATT dataset: 10,000 lines of handwritten Arabic text
- APTI dataset: Arabic printed text images
- Recognition approaches: HMM, SVM, CNN, RNN/LSTM, transformer-based
- Challenges: writer variability, stroke thickness, slant, spacing`,
    });
    const n = await ingestItems(tenant.id, application.id, source.id, "Arabic OCR text recognition handwriting recognition connected letters RTL diacritics", items);
    console.log(`  ✓ Ingested ${n} Arabic OCR knowledge items\n`);
    total += n;
  }

  // ─── 4. ARABIC NLP + MORPHOLOGY ─────────────────────────────────────
  console.log("━━━ 4. ARABIC NLP + MORPHOLOGY ━━━");
  {
    const source = await ensureSource(tenant.id, "Arabic NLP + Morphology — Natural Language Processing for Arabic", "Wikipedia (Arabic NLP)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Arabic_morphology",
      "https://en.wikipedia.org/wiki/Semitic_languages",
      "https://en.wikipedia.org/wiki/Arabic_grammar",
      "https://en.wikipedia.org/wiki/Arabic_phonology",
      "https://en.wikipedia.org/wiki/Diglossia",
      "https://en.wikipedia.org/wiki/Modern_Standard_Arabic",
      "https://en.wikipedia.org/wiki/Arabic_dialects",
    ], "Arabic NLP + Morphology");
    const n = await ingestItems(tenant.id, application.id, source.id, "Arabic NLP morphology grammar phonology dialects MSA diglossia Semitic", items);
    console.log(`  ✓ Ingested ${n} Arabic NLP knowledge items\n`);
    total += n;
  }

  // ─── 5. ARABIC TEXT EXTRACTION + DOCUMENT ANALYSIS ──────────────────
  console.log("━━━ 5. ARABIC TEXT EXTRACTION + DOCUMENT ANALYSIS ━━━");
  {
    const source = await ensureSource(tenant.id, "Arabic Text Extraction + Document Analysis", "Wikipedia (document analysis + text extraction)", "PUBLIC");
    const items = await fetchFromUrls([
      "https://en.wikipedia.org/wiki/Document_image_analysis",
      "https://en.wikipedia.org/wiki/Layout_analysis",
      "https://en.wikipedia.org/wiki/Text_segmentation",
      "https://en.wikipedia.org/wiki/Bidirectional_text",
      "https://en.wikipedia.org/wiki/Unicode",
      "https://en.wikipedia.org/wiki/Arabic_script_in_Unicode",
      "https://en.wikipedia.org/wiki/Arabic_Unicode",
    ], "Arabic Text Extraction + Document Analysis");
    const n = await ingestItems(tenant.id, application.id, source.id, "Arabic text extraction document analysis layout segmentation bidirectional Unicode", items);
    console.log(`  ✓ Ingested ${n} Arabic text extraction knowledge items\n`);
    total += n;
  }

  // ─── 6. FRESH AIS VESSEL DATA (refresh positions) ──────────────────
  console.log("━━━ 6. FRESH AIS VESSEL DATA (refresh) ━━━");
  {
    const vesselFile = "/tmp/ais-vessels-r3.json";
    if (!existsSync(vesselFile)) { console.log("  ✗ ais-vessels-r3.json not found\n"); }
    else {
      const source = await ensureSource(tenant.id, "AIS Live Vessel Tracking — Real-Time Positions", "AIS Stream API (aisstream.io)", "PUBLIC");
      const deleted = await db.knowledgeItem.deleteMany({ where: { sourceId: source.id } });
      console.log(`  Deleted old vessel items: ${deleted.count}`);
      const vessels = JSON.parse(readFileSync(vesselFile, "utf-8"));
      console.log(`  Loaded ${vessels.length} fresh vessels`);
      const data = vessels.map((v: any) => {
        const name = v.shipName || "Unknown";
        const claim = `Vessel "${name}" (MMSI ${v.mmsi}) — live position ${v.latitude.toFixed(2)},${v.longitude.toFixed(2)}`;
        const content = `LIVE AIS VESSEL TRACKING: MMSI: ${v.mmsi}${v.imo ? ", IMO: " + v.imo : ""}. Vessel Name: ${name}. Position: ${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}.${v.sog !== undefined ? " Speed: " + v.sog.toFixed(1) + " knots." : ""}${v.shipType ? " Type: " + v.shipType + "." : ""}${v.destination ? " Destination: " + v.destination + "." : ""}${v.callSign ? " CallSign: " + v.callSign + "." : ""} Data Source: AIS Stream API (aisstream.io) REAL-TIME. Messages: ${v.messageCount}.`;
        return { tenantId: tenant.id, applicationId: application.id, sourceId: source.id, type: "OBSERVATION", scope: "APPLICATION", claim, content,
          contentVector: serializeVector(buildTermVector(claim + " " + content + " vessel AIS tracking maritime shipping")), status: "ACTIVE", confidence: 0.95, validFrom: new Date(), refreshSchedule: "hourly", lastRefreshedAt: new Date() };
      });
      let inserted = 0;
      for (let i = 0; i < data.length; i += 100) {
        const result = await db.knowledgeItem.createMany({ data: data.slice(i, i + 100), skipDuplicates: true });
        inserted += result.count;
      }
      console.log(`  ✓ Ingested ${inserted} fresh vessel positions\n`);
      total += inserted;
    }
  }

  // Audit
  await db.auditEvent.create({
    data: { tenantId: tenant.id, actorType: "system", actorId: "brain.arabic-vessel-r3", action: "knowledge.arabic_vessel_r3", target: "knowledge-base", reason: `Arabic reading/handwriting databases ingested + fresh AIS vessels. New items: ${total}`, severity: "INFO" }
  }).catch(() => {});

  const finalCount = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  ARABIC + VESSEL INGESTION COMPLETE                          ║`);
  console.log(`║  New items ingested: ${total}                                     ║`);
  console.log(`║  Total ACTIVE knowledge: ${finalCount}                             ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

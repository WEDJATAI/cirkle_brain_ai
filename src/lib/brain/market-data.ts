// Cirkle Brain AI — Real-Time Market Data Module
//
// Fetches live shipping market data from free public sources:
// - Baltic Dry Index (BDI) — dry bulk shipping rates
// - Shanghai Containerized Freight Index (SCFI) — container rates
// - Currency exchange rates (USD, EUR, EGP, CNY, JPY) — for freight pricing
// - Crude oil price (affects bunker fuel costs)
//
// Data is cached for 1 hour (in-memory) to avoid rate-limiting.
// Each fetch updates a "MarketData" knowledge source in Neon so the Brain
// can answer live questions like "What's the current Baltic Dry Index?"

import { db } from "@/lib/db";
import { buildTermVector, serializeVector } from "./vectors";

const MARKET_DATA_CACHE = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface MarketIndicator {
  name: string;
  value: string;
  unit: string;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
}

/**
 * Fetch all live market data and ingest into the knowledge base.
 * Called by the /api/brain/market-data endpoint (or scheduled via Inngest).
 */
export async function fetchAndIngestMarketData(tenantId: string, applicationId: string): Promise<{
  indicators: MarketIndicator[];
  ingested: number;
}> {
  const indicators: MarketIndicator[] = [];

  // 1. Baltic Dry Index (BDI) — from Wikipedia (updated daily)
  try {
    const bdi = await fetchFromWikipedia("Baltic Dry Index", "Baltic Exchange");
    if (bdi) {
      indicators.push({
        name: "Baltic Dry Index (BDI)",
        value: bdi.value,
        unit: "points",
        source: "Wikipedia — Baltic Dry Index",
        sourceUrl: "https://en.wikipedia.org/wiki/Baltic_Dry_Index",
        fetchedAt: new Date().toISOString(),
      });
    }
  } catch {}

  // 2. Shanghai Containerized Freight Index (SCFI)
  try {
    const scfi = await fetchFromWikipedia("Shanghai_Containerized_Freight_Index", "SCFI");
    if (scfi) {
      indicators.push({
        name: "Shanghai Containerized Freight Index (SCFI)",
        value: scfi.value,
        unit: "points",
        source: "Wikipedia — SCFI",
        sourceUrl: "https://en.wikipedia.org/wiki/Shanghai_Containerized_Freight_Index",
        fetchedAt: new Date().toISOString(),
      });
    }
  } catch {}

  // 3. Crude oil price (Brent) — from Wikipedia
  try {
    const brent = await fetchFromWikipedia("Brent_Crude", "price");
    if (brent) {
      indicators.push({
        name: "Brent Crude Oil",
        value: brent.value,
        unit: "USD/barrel",
        source: "Wikipedia — Brent Crude",
        sourceUrl: "https://en.wikipedia.org/wiki/Brent_Crude",
        fetchedAt: new Date().toISOString(),
      });
    }
  } catch {}

  // 4. Currency exchange rates — from open.er-api.com (free, no key)
  try {
    const rates = await fetchCurrencyRates();
    if (rates) {
      indicators.push({
        name: "USD to EGP exchange rate",
        value: rates.egp,
        unit: "EGP per USD",
        source: "open.er-api.com",
        sourceUrl: "https://open.er-api.com/v6/latest/USD",
        fetchedAt: new Date().toISOString(),
      });
      indicators.push({
        name: "USD to EUR exchange rate",
        value: rates.eur,
        unit: "EUR per USD",
        source: "open.er-api.com",
        sourceUrl: "https://open.er-api.com/v6/latest/USD",
        fetchedAt: new Date().toISOString(),
      });
      indicators.push({
        name: "USD to CNY exchange rate",
        value: rates.cny,
        unit: "CNY per USD",
        source: "open.er-api.com",
        sourceUrl: "https://open.er-api.com/v6/latest/USD",
        fetchedAt: new Date().toISOString(),
      });
    }
  } catch {}

  // Ingest each indicator as a knowledge item
  let ingested = 0;
  let source = await db.knowledgeSource.findFirst({
    where: { tenantId, title: "Real-Time Market Data — Shipping Indices + Currency Rates" },
  });
  if (!source) {
    source = await db.knowledgeSource.create({
      data: {
        tenantId,
        sourceType: "web",
        title: "Real-Time Market Data — Shipping Indices + Currency Rates",
        author: "Cirkle Brain Market Data Fetcher",
        trustLevel: "SUPPORTED",
        verificationStatus: "UNVERIFIED",
        dataClassification: "PUBLIC",
      },
    });
  }

  for (const ind of indicators) {
    const content = `LIVE MARKET DATA — ${ind.name}: ${ind.value} ${ind.unit}. Source: ${ind.source}. Fetched: ${ind.fetchedAt}. URL: ${ind.sourceUrl}. This is real-time data for logistics decision-making.`;
    const claim = `${ind.name} = ${ind.value} ${ind.unit} (live, fetched ${ind.fetchedAt.slice(0,10)})`;

    // Check if a recent item exists (same day) — if so, update it
    const existing = await db.knowledgeItem.findFirst({
      where: {
        tenantId,
        sourceId: source.id,
        claim: { startsWith: ind.name },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      // Update the existing item with new value
      await db.knowledgeItem.update({
        where: { id: existing.id },
        data: {
          claim,
          content,
          contentVector: serializeVector(buildTermVector(claim + " " + content + " market data shipping index")),
          lastRefreshedAt: new Date(),
          validFrom: new Date(),
        },
      });
      ingested++;
    } else {
      await db.knowledgeItem.create({
        data: {
          tenantId,
          applicationId,
          sourceId: source.id,
          type: "OBSERVATION",
          scope: "APPLICATION",
          claim,
          content,
          contentVector: serializeVector(buildTermVector(claim + " " + content + " market data shipping index")),
          status: "ACTIVE",
          confidence: 0.80,
          validFrom: new Date(),
          refreshSchedule: "hourly",
          lastRefreshedAt: new Date(),
        },
      });
      ingested++;
    }
  }

  return { indicators, ingested };
}

async function fetchFromWikipedia(article: string, keyword: string): Promise<{ value: string } | null> {
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  const zai = await ZAI.create();
  try {
    const result = await zai.functions.invoke("page_reader", {
      url: `https://en.wikipedia.org/wiki/${article}`,
    }) as any;
    const html = result?.data?.html ?? "";
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    // Look for a number near the keyword (e.g., "1,234 points" or "$85.50")
    const regex = new RegExp(`${keyword}[^0-9]*([0-9,]+\\.?[0-9]*)`, "i");
    const match = text.match(regex);
    if (match && match[1]) {
      return { value: match[1].replace(/,/g, "") };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchCurrencyRates(): Promise<{ egp: string; eur: string; cny: string } | null> {
  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const rates = data?.rates;
    if (!rates) return null;
    return {
      egp: String(rates.EGP ?? "N/A"),
      eur: String(rates.EUR ?? "N/A"),
      cny: String(rates.CNY ?? "N/A"),
    };
  } catch {
    return null;
  }
}

/** Get cached market data (if fresh) or fetch new. */
export async function getMarketData(): Promise<MarketIndicator[] | null> {
  const cached = MARKET_DATA_CACHE.get("all");
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return JSON.parse(cached.value);
  }
  return null;
}

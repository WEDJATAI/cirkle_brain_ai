// Cirkle Brain AI — AIS Stream API Integration for Vessel Tracking
//
// Integrates the AIS Stream API (https://aisstream.io/) for real-time
// vessel position tracking. The API uses WebSocket to stream AIS messages
// from ships worldwide — including MMSI, IMO number, vessel name, position,
// speed, heading, destination, and ETA.
//
// This module:
// 1. Connects to wss://stream.aisstream.io/v0/stream
// 2. Subscribes to vessel positions worldwide (or by bounding box)
// 3. Parses AIS messages (PositionReport, ShipStaticData, StandardizedAid)
// 4. Stores vessel data in memory + can persist to the knowledge base
// 5. Exposes a tool for the Brain to query live vessel positions
//
// API key: provided by user
// Documentation: https://aisstream.io/documentation

export interface AisVesselPosition {
  mmsi: number;            // Maritime Mobile Service Identity (9 digits)
  imo?: number;            // International Maritime Organization number
  shipName?: string;       // Vessel name
  latitude: number;
  longitude: number;
  sog?: number;            // Speed over ground (knots)
  cog?: number;            // Course over ground (degrees)
  heading?: number;        // True heading (degrees)
  navStatus?: string;      // Navigation status (Under way, At anchor, etc.)
  destination?: string;    // Destination port
  eta?: string;            // Estimated time of arrival
  shipType?: string;       // Ship type (Cargo, Tanker, Passenger, etc.)
  draught?: number;        // Draught (meters)
  timestamp: number;
}

export interface AisVesselStatic {
  mmsi: number;
  imo?: number;
  shipName?: string;
  shipType?: string;
  callSign?: string;
  flag?: string;
  destination?: string;
  eta?: string;
  draught?: number;
  dimensions?: { toBow: number; toStern: number; toPort: number; toStarboard: number };
}

// In-memory vessel store (updated by WebSocket stream)
// For production multi-instance, would persist to Neon/Turso
const vesselPositions = new Map<number, AisVesselPosition>();
const vesselStatic = new Map<number, AisVesselStatic>();

let wsConnection: WebSocket | null = null;
let isStreaming = false;

/**
 * Connect to the AIS Stream API WebSocket and start receiving vessel positions.
 * Returns true if connection was established.
 *
 * @param apiKey  The AIS Stream API key
 * @param boundingBox  Optional [latMin, lonMin, latMax, lonMax] to filter by region.
 *                     If null, subscribes worldwide.
 * @param onMessage  Optional callback for each AIS message.
 */
export async function startAisStream(
  apiKey: string,
  boundingBox?: [number, number, number, number],
  onMessage?: (vessel: AisVesselPosition) => void,
): Promise<boolean> {
  if (isStreaming) {
    console.log("[ais-stream] Already streaming — skipping reconnect");
    return true;
  }

  const wsUrl = "wss://stream.aisstream.io/v0/stream";

  try {
    // Use the WebSocket API (available in Node 18+ and browsers)
    const ws = new WebSocket(wsUrl);
    wsConnection = ws;

    ws.onopen = () => {
      console.log("[ais-stream] WebSocket connected — subscribing to vessel positions");
      // Send subscription message
      const subscription = {
        Apikey: apiKey,
        PeriodicInterval: 0, // 0 = receive every message, 60 = every 60 seconds
        BoundingBoxes: boundingBox
          ? [[boundingBox]]
          : [[[-90, -180], [90, 180]]], // worldwide
        FilterShipTypes: [], // all ship types
        FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardizedAid"],
      };
      ws.send(JSON.stringify(subscription));
      isStreaming = true;
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as any;

        // AIS Stream wraps messages in an envelope
        const messageType = data.MessageType;
        const metaData = data.MetaData || {};
        const message = data.Message || data;

        if (messageType === "PositionReport") {
          const pos = message.PositionReport || message;
          const vessel: AisVesselPosition = {
            mmsi: metaData.MMSI ?? pos.MMSI ?? 0,
            latitude: pos.Latitude ?? metaData.Latitude ?? 0,
            longitude: pos.Longitude ?? metaData.Longitude ?? 0,
            sog: pos.Sog,
            cog: pos.Cog,
            heading: pos.TrueHeading,
            navStatus: pos.NavigationStatus,
            timestamp: Date.now(),
          };
          if (vessel.mmsi > 0) {
            vesselPositions.set(vessel.mmsi, vessel);
            onMessage?.(vessel);
          }
        } else if (messageType === "ShipStaticData") {
          const sd = message.ShipStaticData || message;
          const staticData: AisVesselStatic = {
            mmsi: metaData.MMSI ?? sd.MMSI ?? 0,
            imo: sd.ImoNumber,
            shipName: sd.ShipName?.trim() || metaData.ShipName?.trim(),
            shipType: sd.Type ? mapShipType(sd.Type) : undefined,
            callSign: sd.CallSign?.trim(),
            destination: sd.Destination?.trim(),
            eta: sd.Eta,
            draught: sd.Draught,
            dimensions: sd.Dimension,
          };
          if (staticData.mmsi > 0) {
            vesselStatic.set(staticData.mmsi, staticData);
          }
        }
      } catch {
        // Skip unparseable messages
      }
    };

    ws.onerror = (err: Event) => {
      console.error("[ais-stream] WebSocket error:", err);
      isStreaming = false;
    };

    ws.onclose = () => {
      console.log("[ais-stream] WebSocket closed");
      isStreaming = false;
      wsConnection = null;
    };

    // Wait for connection
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    return isStreaming;
  } catch (err: any) {
    console.error("[ais-stream] Failed to connect:", err?.message ?? err);
    return false;
  }
}

/** Stop the AIS stream. */
export function stopAisStream(): void {
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
    isStreaming = false;
    console.log("[ais-stream] Stopped streaming");
  }
}

/** Get the current count of tracked vessels. */
export function getTrackedVesselCount(): number {
  return vesselPositions.size;
}

/** Get all known vessel positions (snapshot). */
export function getAllVesselPositions(): AisVesselPosition[] {
  return Array.from(vesselPositions.values());
}

/** Get all known vessel static data (names, types, etc.). */
export function getAllVesselStatic(): AisVesselStatic[] {
  return Array.from(vesselStatic.values());
}

/** Look up a vessel by MMSI. */
export function getVesselByMmsi(mmsi: number): { position?: AisVesselPosition; static?: AisVesselStatic } {
  return {
    position: vesselPositions.get(mmsi),
    static: vesselStatic.get(mmsi),
  };
}

/** Search vessels by name (partial match, case-insensitive). */
export function searchVesselsByName(name: string): Array<{ position?: AisVesselPosition; static?: AisVesselStatic }> {
  const lower = name.toLowerCase().trim();
  const results: Array<{ position?: AisVesselPosition; static?: AisVesselStatic }> = [];
  for (const [mmsi, s] of vesselStatic.entries()) {
    if (s.shipName?.toLowerCase().includes(lower)) {
      results.push({ position: vesselPositions.get(mmsi), static: s });
    }
  }
  return results;
}

/** Map AIS ship type code to human-readable name. */
function mapShipType(type: number): string {
  const types: Record<number, string> = {
    0: "Not available",
    20: "Wing in ground",
    30: "Fishing",
    31: "Towing",
    32: "Towing (large)",
    33: "Dredging",
    34: "Diving",
    35: "Military",
    36: "Sailing",
    37: "Pleasure craft",
    40: "High-speed craft",
    50: "Pilot vessel",
    51: "Search and rescue",
    52: "Tug",
    53: "Port tender",
    54: "Anti-pollution",
    55: "Law enforcement",
    58: "Medical transport",
    59: "Noncombatant",
    60: "Passenger",
    70: "Cargo",
    71: "Cargo — hazardous category A",
    72: "Cargo — hazardous category B",
    73: "Cargo — hazardous category C",
    74: "Cargo — hazardous category D",
    80: "Tanker",
    81: "Tanker — hazardous A",
    82: "Tanker — hazardous B",
    83: "Tanker — hazardous C",
    84: "Tanker — hazardous D",
    90: "Other",
  };
  return types[type] ?? `Type ${type}`;
}

/** Check if the AIS Stream API key is configured. */
export function isAisStreamConfigured(): boolean {
  return !!process.env.AIS_STREAM_API_KEY;
}

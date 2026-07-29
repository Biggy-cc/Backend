import { computeTrackRecord, type TrackRecordPayload } from "../picks/grading.js";

/** Serve cache for 10m; background refresh never blocks the HTTP handler. */
const FRESH_MS = 10 * 60_000;
/** Keep serving stale up to 6h if refresh fails. */
const STALE_MAX_MS = 6 * 60 * 60_000;

let cached: { at: number; payload: TrackRecordPayload } | null = null;
let inflight: Promise<TrackRecordPayload> | null = null;

function emptyPayload(): TrackRecordPayload {
  return {
    streak: { wins: 0, total: 0, label: "—", tier: "hit" },
    stats: {
      settledLegs: { wins: 0, total: 0 },
      hitLegs: { wins: 0, total: 0 },
    },
    provenance: {
      scoreSources: {
        apiFootball: 0,
        highlightly: 0,
        txline: 0,
        manual: 0,
      },
      oddsVerifiedLegs: 0,
      settledLegs: 0,
    },
    recentWins: [],
    updatedAt: new Date().toISOString(),
  };
}

async function refresh(): Promise<TrackRecordPayload> {
  const payload = await computeTrackRecord();
  cached = { at: Date.now(), payload };
  return payload;
}

function kickRefresh(): void {
  if (inflight) return;
  inflight = refresh()
    .catch((err) => {
      console.error("[track-record] background refresh failed:", err);
      return cached?.payload ?? emptyPayload();
    })
    .finally(() => {
      inflight = null;
    });
}

/**
 * Fast path for the site: never wait on Highlightly / multi-date AF fetches.
 * Returns cache immediately; refreshes in the background when stale.
 */
export async function getTrackRecordPayload(): Promise<TrackRecordPayload> {
  const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;

  if (cached && age < FRESH_MS) {
    return cached.payload;
  }

  if (cached && age < STALE_MAX_MS) {
    kickRefresh();
    return cached.payload;
  }

  // Cold start — one compute; caller has a 12s timeout.
  kickRefresh();
  if (inflight) return inflight;
  return emptyPayload();
}

/** Bust cache after wins settle (optional). */
export function invalidateTrackRecordCache(): void {
  cached = null;
  kickRefresh();
}

/** Cron: keep cache warm so /api/track-record stays instant. */
export function refreshTrackRecordInBackground(): void {
  kickRefresh();
}

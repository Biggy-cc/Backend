import { computeTrackRecord, type TrackRecordPayload } from "../picks/grading.js";

const CACHE_MS = 120_000;
let cached: { at: number; payload: TrackRecordPayload } | null = null;

export async function getTrackRecordPayload(): Promise<TrackRecordPayload> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.payload;
  }
  const payload = await computeTrackRecord();
  cached = { at: Date.now(), payload };
  return payload;
}

/** Bust cache when a match finishes (optional manual hook). */
export function invalidateTrackRecordCache(): void {
  cached = null;
}

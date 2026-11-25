import assert from "node:assert/strict";
import { utcDatesForLocalDate } from "../dist/api/live-scores.js";

assert.deepEqual(utcDatesForLocalDate("2026-11-25", "UTC"), ["2026-11-25"]);
assert.deepEqual(utcDatesForLocalDate("2026-11-25", "Europe/Berlin"), ["2026-11-24", "2026-11-25"]);
assert.deepEqual(utcDatesForLocalDate("2026-11-25", "America/Los_Angeles"), ["2026-11-25", "2026-11-26"]);
assert.deepEqual(utcDatesForLocalDate("2026-03-29", "Europe/Berlin"), ["2026-03-28", "2026-03-29"]);
assert.deepEqual(utcDatesForLocalDate("2026-11-25", "Pacific/Kiritimati"), ["2026-11-24", "2026-11-25"]);
console.log("Local score date boundary checks passed");

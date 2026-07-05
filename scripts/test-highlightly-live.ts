import "dotenv/config";
import { buildLivePitchBlock } from "../src/picks/live-tracker.js";

const block = await buildLivePitchBlock("2026-07-05", "hit");
console.log(block?.html ?? "no block");

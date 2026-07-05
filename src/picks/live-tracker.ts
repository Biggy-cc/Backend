import {
  findHighlightlyMatch,
  highlightlyLiveState,
  isHighlightlyConfigured,
  loadHighlightlyMatchesForLegs,
  scoreForPickLabel,
  type HighlightlyMatch,
} from "../highlightly/client.js";
import { loadStoredBatch } from "./store.js";
import {
  evaluateLegProgress,
  matchScore,
  normalizeMatchKey,
  progressEmoji,
  type PickLeg,
} from "./grading.js";
import type { PickTier } from "./types.js";
import { formatTierLabel } from "./types.js";
import type { MatchThesis } from "./validate.js";

export type MatchPhase = "pre" | "live" | "ft";

export type LegLiveState = {
  leg: PickLeg;
  matchLabel: string;
  phase: MatchPhase;
  scoreLine: string | null;
  clock: string;
  progress: ReturnType<typeof evaluateLegProgress> | null;
  thesis: MatchThesis | null;
};

export type LivePitchBlock = {
  html: string;
  legs: LegLiveState[];
  hasLiveAction: boolean;
};

function normalizeMatchName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function legStateFromHighlightly(
  leg: PickLeg,
  hl: HighlightlyMatch,
  thesis: MatchThesis | null
): LegLiveState {
  const live = highlightlyLiveState(hl);
  const score =
    scoreForPickLabel(leg.match, hl) ??
    (live.score ? scoreForPickLabel(`${hl.homeTeam.name} vs ${hl.awayTeam.name}`, hl) : null);

  const progress =
    score && live.phase !== "pre"
      ? evaluateLegProgress(leg, score, live.phase === "ft" ? "ft" : "live")
      : null;

  return {
    leg,
    matchLabel: leg.match,
    phase: live.phase,
    scoreLine: score ? `${score.home}-${score.away}` : null,
    clock: live.clock,
    progress,
    thesis,
  };
}

function legStateFromSettled(
  leg: PickLeg,
  thesis: MatchThesis | null
): LegLiveState | null {
  const settled = matchScore(normalizeMatchKey(leg.match));
  if (!settled) return null;

  const progress = evaluateLegProgress(leg, settled, "ft");
  return {
    leg,
    matchLabel: leg.match,
    phase: "ft",
    scoreLine: `${settled.home}-${settled.away}`,
    clock: "FT",
    progress,
    thesis,
  };
}

export async function buildLegLiveStates(
  pickDate: string,
  tier: PickTier
): Promise<LegLiveState[]> {
  const batch = await loadStoredBatch(pickDate);
  if (!batch) return [];

  const slip = batch.picks[tier];
  if (!slip?.legs?.length) return [];

  const thesisByMatch = new Map(
    batch.thesis.map((t) => [normalizeMatchName(t.match), t])
  );

  const matchLabels = slip.legs.map((l) => l.match);
  const hlByLeg = isHighlightlyConfigured()
    ? await loadHighlightlyMatchesForLegs(pickDate, matchLabels)
    : new Map<string, HighlightlyMatch>();

  const states: LegLiveState[] = [];

  for (const leg of slip.legs) {
    const matchKey = normalizeMatchKey(leg.match);
    const thesis = thesisByMatch.get(normalizeMatchName(leg.match)) ?? null;
    const hl = hlByLeg.get(matchKey);

    if (hl) {
      states.push(legStateFromHighlightly(leg, hl, thesis));
      continue;
    }

    const settled = legStateFromSettled(leg, thesis);
    if (settled) {
      states.push(settled);
      continue;
    }

    states.push({
      leg,
      matchLabel: leg.match,
      phase: "pre",
      scoreLine: null,
      clock: isHighlightlyConfigured() ? "Awaiting live feed" : "Scheduled",
      progress: null,
      thesis,
    });
  }

  return states;
}

export function legStateFingerprint(state: LegLiveState): string {
  return [
    state.matchLabel,
    state.phase,
    state.clock,
    state.scoreLine ?? "",
    state.progress?.state ?? "",
    state.progress?.message ?? "",
  ].join("|");
}

export type LivePanelOptions = {
  autoWatch?: boolean;
  tier?: PickTier;
};

export function buildLivePitchPanelHtml(
  legs: LegLiveState[],
  options: LivePanelOptions = {}
): string {
  const source = isHighlightlyConfigured() ? "Highlightly" : "cached results";
  const tierLabel = options.tier ? formatTierLabel(options.tier) : "your";

  const footer = options.autoWatch
    ? `<i>Watching ${tierLabel} slip · auto-updates while matches are live</i>`
    : `<i>Tap ⚡ Refresh live for the latest from the pitch</i>`;

  const lines = legs.map((state, i) => {
    const scorePart = state.scoreLine ? ` · ${state.scoreLine}` : "";
    const header = `${i + 1}. ${escapeHtml(state.matchLabel)} · ${escapeHtml(state.clock)}${scorePart}`;

    let body = `   → ${escapeHtml(state.leg.selection)}`;
    if (state.progress) {
      body += `\n   ${progressEmoji(state.progress.state)} ${escapeHtml(state.progress.message)}`;
    } else if (state.phase === "live") {
      body += `\n   ⚽ In play — tracking via ${source}`;
    } else if (state.phase === "pre") {
      body += "\n   ⏳ Pre-match — lean holds until kickoff";
    }

    if (state.thesis?.summary) {
      body += `\n   💡 ${escapeHtml(state.thesis.summary.slice(0, 120))}${state.thesis.summary.length > 120 ? "…" : ""}`;
    }

    return `${header}\n${body}`;
  });

  return `<b>⚡ Live on the pitch</b>
${footer}

${lines.join("\n\n")}`;
}

function kickoffMinutesFromClock(clock: string): number | null {
  const m = clock.match(/Kickoff in (?:(\d+)h )?(\d+)m/);
  if (!m) return clock === "Kickoff soon" ? 0 : null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2]!, 10);
  return h * 60 + min;
}

function shouldAutoWatchFromLegs(legs: LegLiveState[]): boolean {
  if (legs.some((l) => l.phase === "live")) return true;
  if (legs.every((l) => l.phase === "ft")) return false;
  return legs.some((l) => {
    if (l.phase !== "pre") return false;
    const mins = kickoffMinutesFromClock(l.clock);
    return mins != null && mins <= 30;
  });
}

export { shouldAutoWatchFromLegs as shouldAutoWatchLegs };

export async function buildLivePitchBlock(
  pickDate: string,
  tier: PickTier,
  options: LivePanelOptions = {}
): Promise<LivePitchBlock | null> {
  const legs = await buildLegLiveStates(pickDate, tier);
  if (legs.length === 0) return null;

  const autoWatch = options.autoWatch ?? shouldAutoWatchFromLegs(legs);
  const html = buildLivePitchPanelHtml(legs, { autoWatch, tier, ...options });
  const hasLiveAction = legs.some((l) => l.phase === "live" || l.phase === "ft");

  return { html, legs, hasLiveAction };
}

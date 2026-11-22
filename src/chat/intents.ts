/** Distinguish a target accumulator price from a request for one match's odds. */
export function targetParlayOdds(message: string): number | null {
  const value = message.match(/\b(\d+(?:\.\d+)?)\s*(?:odds|ods)\b/i)?.[1]
    ?? message.match(/\b(?:odds|ods)\s+(?:of\s+)?(\d+(?:\.\d+)?)\b/i)?.[1];
  if (!value || /\b(?:vs\.?|versus|this match|this game)\b/i.test(message)) return null;
  const target = Number(value);
  return Number.isFinite(target) && target >= 1.1 && target <= 1000 ? target : null;
}

export function isParlayRequest(message: string, history: Array<{ role: "user" | "assistant"; content: string }>): boolean {
  return /\b(?:parlays?|parleys?|parly|accumulators?|accas?)\b/i.test(message) || targetParlayOdds(message) !== null ||
    (/^(?:yes|yeah|yep|ok(?:ay)?|go ahead|do it|safe|balanced|go big)[.! ]*$/i.test(message.trim()) && history.slice(-6).some((item) => /\b(?:parlays?|parleys?|parly|accumulators?|accas?)\b/i.test(item.content) || targetParlayOdds(item.content) !== null));
}

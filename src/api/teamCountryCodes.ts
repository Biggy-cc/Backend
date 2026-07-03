/** Map TxLINE participant names to ISO 3166-1 alpha-2 for flag images. */
const TEAM_COUNTRY_CODES: Record<string, string> = {
  Argentina: "AR",
  Algeria: "DZ",
  Australia: "AU",
  Austria: "AT",
  Belgium: "BE",
  "Bosnia & Herzegovina": "BA",
  Brazil: "BR",
  Canada: "CA",
  "Cape Verde": "CV",
  Colombia: "CO",
  Croatia: "HR",
  Egypt: "EG",
  England: "GB",
  France: "FR",
  Germany: "DE",
  Ghana: "GH",
  Japan: "JP",
  Mexico: "MX",
  Morocco: "MA",
  Norway: "NO",
  Paraguay: "PY",
  Portugal: "PT",
  Spain: "ES",
  Switzerland: "CH",
  USA: "US",
};

export function teamToCountryCode(teamName: string): string | null {
  const direct = TEAM_COUNTRY_CODES[teamName.trim()];
  if (direct) return direct;

  const normalized = teamName.trim().toLowerCase();
  for (const [name, code] of Object.entries(TEAM_COUNTRY_CODES)) {
    if (name.toLowerCase() === normalized) return code;
  }

  return null;
}

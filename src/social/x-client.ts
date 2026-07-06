import crypto from "node:crypto";

export function isXConfigured(): boolean {
  return Boolean(
    process.env.X_API_KEY?.trim() &&
      process.env.X_API_SECRET?.trim() &&
      process.env.X_ACCESS_TOKEN?.trim() &&
      process.env.X_ACCESS_TOKEN_SECRET?.trim()
  );
}

function pctEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function oauthHeader(method: string, url: string): string {
  const key = process.env.X_API_KEY!.trim();
  const secret = process.env.X_API_SECRET!.trim();
  const token = process.env.X_ACCESS_TOKEN!.trim();
  const tokenSecret = process.env.X_ACCESS_TOKEN_SECRET!.trim();

  const oauth = {
    oauth_consumer_key: key,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };

  const params = Object.entries(oauth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pctEncode(k)}=${pctEncode(v)}`)
    .join("&");

  const base = `${method.toUpperCase()}&${pctEncode(url)}&${pctEncode(params)}`;
  const signingKey = `${pctEncode(secret)}&${pctEncode(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");

  const header =
    "OAuth " +
    Object.entries({ ...oauth, oauth_signature: signature })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`)
      .join(", ");

  return header;
}

/** Post a tweet (max 280 chars). Returns tweet id or null. */
export async function postTweet(text: string): Promise<string | null> {
  if (!isXConfigured()) {
    console.warn("[x] Credentials missing — skipping post");
    return null;
  }

  const body = text.trim().slice(0, 280);
  const url = "https://api.twitter.com/2/tweets";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: oauthHeader("POST", url),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: body }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[x] Post failed:", res.status, err);
    return null;
  }

  const data = (await res.json()) as { data?: { id?: string } };
  const id = data.data?.id ?? null;
  console.log("[x] Posted", id ?? "(no id)");
  return id;
}

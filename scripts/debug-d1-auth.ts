import "dotenv/config";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();

console.log("Account ID length:", accountId?.length ?? 0);
console.log("Database ID:", databaseId);
console.log("Token prefix:", apiToken?.slice(0, 8) + "…");

// Verify token works at all
const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const verifyBody = (await verifyRes.json()) as {
  success: boolean;
  errors?: Array<{ message: string; code?: number }>;
  result?: { status: string; id: string };
};
console.log("\nToken verify HTTP:", verifyRes.status, "success:", verifyBody.success);
if (verifyBody.result) {
  console.log("Token status:", verifyBody.result.status);
}
if (verifyBody.errors?.length) {
  console.log("Token errors:", verifyBody.errors);
}

// List accounts this token can access
const accountsRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const accountsBody = (await accountsRes.json()) as {
  success: boolean;
  result?: Array<{ id: string; name: string }>;
  errors?: Array<{ message: string }>;
};
console.log("\nAccounts visible to token:", accountsBody.success ? accountsBody.result?.length : "failed");
for (const acct of accountsBody.result ?? []) {
  console.log(`  ${acct.id} — ${acct.name}${acct.id === accountId ? " ← matches .env" : ""}`);
}

// D1 query attempt
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
const d1Res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sql: "SELECT 1 as ok" }),
});
const d1Body = await d1Res.json();
console.log("\nD1 query HTTP:", d1Res.status);
console.log(JSON.stringify(d1Body, null, 2));

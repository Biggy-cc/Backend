type D1QueryResult = {
  success: boolean;
  errors?: Array<{ message: string }>;
  result?: Array<{
    results?: unknown[];
    meta?: { changes?: number };
  }>;
};

export type D1Config = {
  accountId: string;
  databaseId: string;
  apiToken: string;
};

export function getD1Config(): D1Config | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();

  if (!accountId || !databaseId || !apiToken) return null;
  return { accountId, databaseId, apiToken };
}

async function d1Request(
  config: D1Config,
  sql: string,
  params: unknown[] = []
): Promise<D1QueryResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  const body = (await res.json()) as D1QueryResult;
  if (!res.ok || !body.success) {
    const msg =
      body.errors?.map((e) => e.message).join("; ") ??
      `D1 HTTP ${res.status}: ${JSON.stringify(body)}`;
    throw new Error(msg);
  }
  return body;
}

export async function d1Query<T>(
  config: D1Config,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const body = await d1Request(config, sql, params);
  return (body.result?.[0]?.results ?? []) as T[];
}

export async function d1Exec(
  config: D1Config,
  sql: string,
  params: unknown[] = []
): Promise<void> {
  await d1Request(config, sql, params);
}

export async function d1Batch(
  config: D1Config,
  statements: Array<{ sql: string; params?: unknown[] }>
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(statements),
  });

  const body = (await res.json()) as D1QueryResult;
  if (!res.ok || !body.success) {
    const msg =
      body.errors?.map((e) => e.message).join("; ") ??
      `D1 batch HTTP ${res.status}: ${JSON.stringify(body)}`;
    throw new Error(msg);
  }
}

export async function testD1Connection(config: D1Config): Promise<string> {
  const rows = await d1Query<{ ok: number }>(
    config,
    `SELECT 1 as ok`
  );
  if (rows[0]?.ok !== 1) {
    throw new Error("D1 ping returned unexpected result");
  }
  return config.databaseId;
}

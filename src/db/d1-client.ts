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

const D1_FETCH_TIMEOUT_MS = 25_000;
const D1_MAX_ATTEMPTS = 4;

function isTransientD1Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: string } }).cause : null;
  const code = cause?.code ?? "";
  return (
    /fetch failed|EPIPE|ECONNRESET|ETIMEDOUT|socket hang up|network|429|502|503|504/i.test(
      msg
    ) || /EPIPE|ECONNRESET|ETIMEDOUT|UND_ERR/.test(code)
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withD1Retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= D1_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientD1Error(err) || attempt === D1_MAX_ATTEMPTS) break;
      const waitMs = Math.min(8_000, 500 * 2 ** (attempt - 1));
      console.warn(
        `[d1] ${label} failed (attempt ${attempt}/${D1_MAX_ATTEMPTS}) — retry in ${waitMs}ms:`,
        err instanceof Error ? err.message : err
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function d1Request(
  config: D1Config,
  sql: string,
  params: unknown[] = []
): Promise<D1QueryResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  return withD1Retry("query", async () => {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      },
      D1_FETCH_TIMEOUT_MS
    );

    const body = (await res.json()) as D1QueryResult;
    if (!res.ok || !body.success) {
      const msg =
        body.errors?.map((e) => e.message).join("; ") ??
        `D1 HTTP ${res.status}: ${JSON.stringify(body)}`;
      throw new Error(msg);
    }
    return body;
  });
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
  try {
    await withD1Retry("batch", async () => {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ batch: statements }),
        },
        D1_FETCH_TIMEOUT_MS
      );

      const body = (await res.json()) as D1QueryResult;
      if (!res.ok || !body.success) {
        const msg =
          body.errors?.map((e) => e.message).join("; ") ??
          `D1 batch HTTP ${res.status}: ${JSON.stringify(body)}`;
        throw new Error(msg);
      }
    });
  } catch (err) {
    // Large batch can EPIPE — fall back to one statement at a time.
    if (!isTransientD1Error(err) || statements.length <= 1) throw err;
    console.warn(
      `[d1] batch failed after retries — writing ${statements.length} statements sequentially`
    );
    for (const stmt of statements) {
      await d1Request(config, stmt.sql, stmt.params ?? []);
    }
  }
}

export async function testD1Connection(config: D1Config): Promise<string> {
  const rows = await d1Query<{ ok: number }>(config, `SELECT 1 as ok`);
  if (rows[0]?.ok !== 1) {
    throw new Error("D1 ping returned unexpected result");
  }
  return config.databaseId;
}

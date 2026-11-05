/** Shared helpers for talking to forges. */

const REQUEST_TIMEOUT_MS = 30_000;

/** Callers that must be testable without the network pass their own `fetch`. */
export interface ForgeHttpDeps {
  fetchImpl?: typeof fetch;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } & ForgeHttpDeps = {},
): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch, ...rest } = init;
  const response = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${init.method ?? "GET"} ${url} failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

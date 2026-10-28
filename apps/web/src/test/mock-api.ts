import { vi } from "vitest";

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => unknown | Response | Promise<unknown | Response>;

/** `{ error: { code, message } }` response for a route handler. */
export function apiError(
  status: number,
  code: string,
  message = code,
  details?: unknown,
): Response {
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

/**
 * Stubs `fetch` with routes keyed `"METHOD /api/path"`. A handler returns a `Response` (use
 * `apiError`) or any JSON value (sent as 200). Unknown routes answer 404 and are recorded.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const call: RecordedCall = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return apiError(404, "not_found", `No mock for ${method} ${url.pathname}`);
    const result = await handler(call);
    return result instanceof Response ? result : Response.json(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    called: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

import { okResponseSchema } from "@pm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi } from "../test/mock-api.ts";
import { ApiError, api, clockTracker, setUnauthorizedHandler } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("api client", () => {
  it("parses a 2xx response with the given schema and sends credentials", async () => {
    const { fetchMock } = mockApi({ "GET /api/thing": () => ({ ok: true }) });
    const result = await api.get("/api/thing", { schema: okResponseSchema });
    expect(result).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("GET");
  });

  it("sends JSON bodies, `{}` for body-less POST, and builds the query string", async () => {
    const { calls, fetchMock } = mockApi({
      "POST /api/a": () => ({ ok: true }),
      "GET /api/b": () => ({ ok: true }),
    });
    await api.post("/api/a", { body: { x: 1 }, schema: okResponseSchema });
    await api.post("/api/a", { schema: okResponseSchema });
    await api.get("/api/b", { schema: okResponseSchema, query: { limit: 5, before: undefined } });
    expect(calls[0]?.body).toEqual({ x: 1 });
    expect(calls[1]?.body).toEqual({});
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("/api/b?limit=5");
    expect(((fetchMock.mock.calls[0] ?? [])[1] as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  it("rejects a response that does not match the schema", async () => {
    mockApi({ "GET /api/thing": () => ({ ok: "yes" }) });
    const error = await api.get("/api/thing", { schema: okResponseSchema }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("maps an error body to ApiError with status, code, message and details", async () => {
    mockApi({
      "POST /api/x": () => apiError(429, "rate_limited", "Slow down", { retryAfterSeconds: 30 }),
    });
    const error = await api.post("/api/x", { schema: okResponseSchema }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Slow down",
      details: { retryAfterSeconds: 30 },
    });
  });

  it("maps an unparseable error body and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })),
    );
    await expect(api.get("/api/x", { schema: okResponseSchema })).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(api.get("/api/x", { schema: okResponseSchema })).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });

  it("calls the unauthorized handler on 401 unauthorized only", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    mockApi({
      "GET /api/a": () => apiError(401, "unauthorized"),
      "POST /api/login": () => apiError(401, "invalid_credentials"),
    });
    await api
      .get("/api/a", { schema: okResponseSchema, handleUnauthorized: false })
      .catch(() => {});
    await api.post("/api/login", { schema: okResponseSchema }).catch(() => {});
    expect(handler).not.toHaveBeenCalled();
    await expect(api.get("/api/a", { schema: okResponseSchema })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("feeds the Date header to the clock tracker", async () => {
    const serverTime = Date.now() + 60_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true }, { headers: { Date: new Date(serverTime).toUTCString() } }),
      ),
    );
    await api.get("/api/clock", { schema: okResponseSchema });
    await api.get("/api/clock", { schema: okResponseSchema });
    await api.get("/api/clock", { schema: okResponseSchema });
    expect(Math.abs(clockTracker.offsetMs() - 60_000)).toBeLessThan(3000);
    expect(clockTracker.shouldApply()).toBe(true);
  });
});

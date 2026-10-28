import { okResponseSchema } from "@pm/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../test/fake-crypto.ts";
import { apiError, mockApi } from "../test/mock-api.ts";
import { ApiError, api } from "./api.ts";
import { lockStore, ME_QUERY_KEY } from "./session.ts";
import { wireApp } from "./wiring.ts";

let crashListener: (() => void) | null = null;

vi.mock("../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../crypto-worker/client.ts")>();
  const { cryptoCall } = await import("../test/fake-crypto.ts");
  return {
    ...actual,
    cryptoClient: {
      call: cryptoCall,
      onCrash: (listener: () => void) => {
        crashListener = listener;
        return () => {};
      },
      terminate: () => {},
    },
  };
});

let cleanup: (() => void) | null = null;

beforeEach(() => {
  cryptoCall.mockReset();
  lockStore.set("unlocked");
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});

describe("wireApp", () => {
  it("on 401 unauthorized: goes to /login, locks the worker and clears the cache", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, { user: {} });
    queryClient.setQueryData(["vault", "items"], ["decrypted"]);
    const goToLogin = vi.fn(async () => undefined);
    cleanup = wireApp(queryClient, goToLogin);
    mockApi({ "GET /api/me/keys": () => apiError(401, "unauthorized") });

    await expect(api.get("/api/me/keys", { schema: okResponseSchema })).rejects.toBeInstanceOf(
      ApiError,
    );
    await vi.waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));
    expect(goToLogin).toHaveBeenCalledTimes(1);
    expect(cryptoCall).toHaveBeenCalledWith("lock");
    expect(lockStore.get()).toBe("locked");
  });

  it("handles a burst of 401s once", async () => {
    const queryClient = new QueryClient();
    const goToLogin = vi.fn(async () => undefined);
    cleanup = wireApp(queryClient, goToLogin);
    mockApi({ "GET /api/a": () => apiError(401, "unauthorized") });
    await Promise.allSettled([
      api.get("/api/a", { schema: okResponseSchema }),
      api.get("/api/a", { schema: okResponseSchema }),
      api.get("/api/a", { schema: okResponseSchema }),
    ]);
    await vi.waitFor(() => expect(goToLogin).toHaveBeenCalled());
    expect(goToLogin).toHaveBeenCalledTimes(1);
  });

  it("drops cached data except the session on lock", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, { user: {} });
    queryClient.setQueryData(["vault", "items"], ["decrypted"]);
    queryClient.setQueryData(["settings", "sessions"], []);
    cleanup = wireApp(queryClient, async () => undefined);
    lockStore.set("locked");
    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeDefined();
    expect(queryClient.getQueryData(["vault", "items"])).toBeUndefined();
    expect(queryClient.getQueryData(["settings", "sessions"])).toBeUndefined();
  });

  it("treats a worker crash as locked", () => {
    cleanup = wireApp(new QueryClient(), async () => undefined);
    crashListener?.();
    expect(lockStore.get()).toBe("locked");
  });

  it("locks when the page is restored from the back/forward cache", () => {
    cleanup = wireApp(new QueryClient(), async () => undefined);
    const event = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
    expect(lockStore.get()).toBe("locked");
    expect(cryptoCall).toHaveBeenCalledWith("lock");
  });
});

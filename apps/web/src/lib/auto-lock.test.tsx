import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../test/fake-crypto.ts";
import { startAutoLock } from "./auto-lock.ts";
import { lockStore, useAutoLock } from "./session.ts";

vi.mock("../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  cryptoCall.mockReset();
  lockStore.set("unlocked");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startAutoLock", () => {
  it("locks after the idle period", () => {
    const onLock = vi.fn();
    const stop = startAutoLock({ minutes: 5, onLock });
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("restarts the countdown on keyboard and pointer activity", () => {
    const onLock = vi.fn();
    const stop = startAutoLock({ minutes: 5, onLock });
    vi.advanceTimersByTime(4 * MINUTE);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    vi.advanceTimersByTime(4 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(4 * MINUTE + 30_000);
    expect(onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MINUTE);
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing after being stopped", () => {
    const onLock = vi.fn();
    startAutoLock({ minutes: 1, onLock })();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();
  });

  it("locks when the tab becomes visible after the idle period passed (e.g. after sleep)", () => {
    const onLock = vi.fn();
    const stop = startAutoLock({ minutes: 1, onLock });
    // Simulate a suspended timer: the clock jumps but the timeout callback has not run.
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("useAutoLock", () => {
  it("locks the worker and marks the app locked after inactivity", async () => {
    renderHook(() => useAutoLock(15));
    expect(lockStore.get()).toBe("unlocked");
    await act(async () => {
      vi.advanceTimersByTime(15 * MINUTE);
    });
    expect(lockStore.get()).toBe("locked");
    expect(cryptoCall).toHaveBeenCalledWith("lock");
  });

  it("uses the new duration when the setting changes", async () => {
    const { rerender } = renderHook(({ minutes }) => useAutoLock(minutes), {
      initialProps: { minutes: 15 },
    });
    rerender({ minutes: 1 });
    await act(async () => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(lockStore.get()).toBe("locked");
  });
});

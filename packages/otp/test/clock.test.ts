import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClockOffsetTracker } from "../src/index.ts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const header = (ms: number) => new Date(ms).toUTCString();

describe("createClockOffsetTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("is 0 with no samples", () => {
    const t = createClockOffsetTracker();
    expect(t.offsetMs()).toBe(0);
    expect(t.shouldApply()).toBe(false);
    expect(t.now()).toBe(T0);
  });

  it("estimates the server time at the request midpoint", () => {
    const t = createClockOffsetTracker();
    // Device thinks 12:00:00.000-12:00:01.000 (mid .500); server stamped 12:00:30.
    t.addSample(header(T0 + 30_000), T0, T0 + 1_000);
    expect(t.offsetMs()).toBe(30_000 - 500);
  });

  it("uses the median (odd and even counts)", () => {
    const t = createClockOffsetTracker();
    for (const off of [1_000, 50_000, 2_000]) t.addSample(header(T0 + off), T0, T0);
    expect(t.offsetMs()).toBe(2_000);
    t.addSample(header(T0 + 4_000), T0, T0);
    expect(t.offsetMs()).toBe(3_000); // mean of 2000 and 4000
  });

  it("keeps only the last maxSamples", () => {
    const t = createClockOffsetTracker({ maxSamples: 3 });
    for (const off of [100_000, 100_000, 1_000, 2_000, 3_000]) {
      t.addSample(header(T0 + off), T0, T0);
    }
    expect(t.offsetMs()).toBe(2_000);
  });

  it("applies only above the threshold", () => {
    const t = createClockOffsetTracker();
    t.addSample(header(T0 + 10_000), T0, T0);
    expect(t.shouldApply()).toBe(false); // exactly 10 s is not "more than"
    expect(t.now()).toBe(T0);

    const u = createClockOffsetTracker();
    u.addSample(header(T0 + 11_000), T0, T0);
    expect(u.shouldApply()).toBe(true);
    expect(u.now()).toBe(T0 + 11_000);
    expect(u.shouldApply(20_000)).toBe(false);

    const v = createClockOffsetTracker();
    v.addSample(header(T0 - 60_000), T0, T0);
    expect(v.shouldApply()).toBe(true);
    expect(v.now()).toBe(T0 - 60_000);
  });

  it("ignores null, empty and garbage Date headers and bad timings", () => {
    const t = createClockOffsetTracker();
    t.addSample(null, T0, T0);
    t.addSample("", T0, T0);
    t.addSample("not a date", T0, T0);
    t.addSample(header(T0 + 99_000), T0 + 1_000, T0); // response before request
    t.addSample(header(T0 + 99_000), Number.NaN, T0);
    expect(t.offsetMs()).toBe(0);
    expect(t.shouldApply()).toBe(false);
  });
});

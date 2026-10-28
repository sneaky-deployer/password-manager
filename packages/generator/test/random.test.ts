import { describe, expect, it } from "vitest";
import { randomInt, shuffle } from "../src/index.ts";

function seq(...values: number[]) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("rng exhausted");
    return values[i++] as number;
  };
}

describe("randomInt", () => {
  it("stays within bounds", () => {
    for (const max of [1, 2, 3, 7, 10, 90, 7776, 1_000_003]) {
      for (let i = 0; i < 500; i++) {
        const v = randomInt(max);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(max);
      }
    }
  });

  it("is roughly uniform (60k samples, 6 buckets, each within 10% of expected)", () => {
    const buckets = new Array<number>(6).fill(0);
    const n = 60_000;
    for (let i = 0; i < n; i++) {
      const b = randomInt(6);
      buckets[b] = (buckets[b] as number) + 1;
    }
    const expected = n / 6;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.9);
      expect(count).toBeLessThan(expected * 1.1);
    }
  });

  it("rejects invalid bounds", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-1)).toThrow(RangeError);
    expect(() => randomInt(1.5)).toThrow(RangeError);
    expect(() => randomInt(2 ** 32 + 1)).toThrow(RangeError);
  });

  it("discards values in the biased zone and keeps sampling", () => {
    // For max 6: limit = 2^32 - (2^32 % 6) = 4294967292, so 4294967292..4294967295 are rejected.
    let calls = 0;
    const rng = seq(0xffffffff, 0xfffffffc, 0xfffffffd, 7);
    const counted = () => {
      calls++;
      return rng();
    };
    expect(randomInt(6, counted)).toBe(1); // 7 % 6
    expect(calls).toBe(4);
  });

  it("accepts the largest value just below the limit", () => {
    expect(randomInt(6, () => 4294967291)).toBe(4294967291 % 6);
  });

  it("maps values directly when max is a power of two (never rejects)", () => {
    expect(randomInt(2 ** 32, () => 0xffffffff)).toBe(0xffffffff);
    expect(randomInt(16, () => 0xffffffff)).toBe(15);
  });

  it("returns 0 for max 1 without consuming randomness", () => {
    expect(randomInt(1, seq())).toBe(0);
  });
});

describe("shuffle", () => {
  it("returns a permutation and leaves the input untouched", () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const copy = [...input];
    const out = shuffle(input);
    expect(input).toEqual(copy);
    expect([...out].sort((a, b) => a - b)).toEqual(copy);
  });

  it("is deterministic for an injected source (identity when always picking the last index)", () => {
    // j = value % (i + 1); value = i means j = i, i.e. no swaps.
    const input = ["a", "b", "c", "d"];
    const values = [3, 2, 1];
    let k = 0;
    expect(shuffle(input, () => values[k++] as number)).toEqual(input);
  });

  it("can produce every permutation of 3 items", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) seen.add(shuffle(["a", "b", "c"]).join(""));
    expect(seen.size).toBe(6);
  });
});

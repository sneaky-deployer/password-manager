import { describe, expect, it } from "vitest";
import { WORDS_24 } from "../../test/fixtures.ts";
import { assessPassword } from "./password-policy.ts";
import {
  buildRecoveryKitText,
  pickConfirmationIndexes,
  splitPhrase,
  wordsMatch,
} from "./recovery-kit.ts";

describe("recovery kit helpers", () => {
  it("picks three distinct, sorted word positions within range", () => {
    for (let i = 0; i < 200; i++) {
      const indexes = pickConfirmationIndexes(24);
      expect(indexes).toHaveLength(3);
      expect(new Set(indexes).size).toBe(3);
      expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
      expect(indexes.every((n) => n >= 0 && n < 24)).toBe(true);
    }
  });

  it("eventually asks about every position (no bias to the start)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) for (const n of pickConfirmationIndexes(24)) seen.add(n);
    expect(seen.size).toBe(24);
  });

  it("matches typed words ignoring case and surrounding spaces", () => {
    expect(wordsMatch("  Abandon ", "abandon")).toBe(true);
    expect(wordsMatch("abandn", "abandon")).toBe(false);
  });

  it("builds the kit file with all words, the email, the date and instructions", () => {
    const text = buildRecoveryKitText({
      words: WORDS_24,
      email: "alice@example.com",
      date: new Date("2026-10-28T10:00:00Z"),
    });
    expect(text).toContain("alice@example.com");
    expect(text).toContain("2026-10-28");
    expect(text).toContain(" 1. abandon");
    expect(text).toContain("24. actual");
    expect(text).toMatch(/forgot|forget/i);
    expect(splitPhrase(`  ${WORDS_24.join("  ")} `)).toEqual(WORDS_24);
  });
});

describe("password policy", () => {
  it("requires 12+ characters and zxcvbn score 3+", () => {
    expect(assessPassword("short").ok).toBe(false);
    expect(assessPassword("password1234").strongEnough).toBe(false);
    expect(assessPassword("aaaaaaaaaaaaaaaa").ok).toBe(false);
    const good = assessPassword("orange giraffe parachute lantern");
    expect(good.longEnough).toBe(true);
    expect(good.score).toBeGreaterThanOrEqual(3);
    expect(good.ok).toBe(true);
  });

  it("penalises the user's own email", () => {
    const withoutHint = assessPassword("alice.wonderland2026");
    const withHint = assessPassword("alice.wonderland2026", ["alice.wonderland@example.com"]);
    expect(withHint.score).toBeLessThanOrEqual(withoutHint.score);
  });
});

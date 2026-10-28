import { describe, expect, it } from "vitest";
import { z } from "zod";
import { healthResponseSchema } from "../src/index.ts";

describe("zod configuration", () => {
  it("disables zod's eval probe, which the app's Content-Security-Policy would report", () => {
    // Without `jitless`, zod calls `new Function("")` on first use. The CSP has no 'unsafe-eval',
    // so browsers log a violation on every page load (found by the Playwright suite).
    expect(z.config().jitless).toBe(true);
    expect(healthResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it("never reaches for eval or Function while parsing", () => {
    const realFunction = globalThis.Function;
    let calls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test double for the Function constructor
    (globalThis as any).Function = new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      z.object({ a: z.string(), b: z.array(z.number()) }).parse({ a: "x", b: [1] });
    } finally {
      globalThis.Function = realFunction;
    }
    expect(calls).toBe(0);
  });
});

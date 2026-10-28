import { describe, expect, it } from "vitest";
import { sodiumReady } from "./index.ts";

describe("@pm/crypto in the web workspace", () => {
  it("loads libsodium sumo", async () => {
    const sodium = await sodiumReady();
    expect(typeof sodium.crypto_pwhash).toBe("function");
  });
});

import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, sodiumReady } from "../src/index.ts";

describe("@pm/crypto", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@pm/crypto");
  });

  it("loads libsodium sumo with Argon2id support", async () => {
    const sodium = await sodiumReady();
    expect(typeof sodium.crypto_pwhash).toBe("function");
    expect(sodium.crypto_pwhash_ALG_ARGON2ID13).toBeGreaterThan(0);
  });
});

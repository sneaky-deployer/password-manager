import { defineConfig } from "vitest/config";

export default defineConfig({
  // Argon2id with the default parameters takes ~1 s in WASM; leave headroom for slow CI.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});

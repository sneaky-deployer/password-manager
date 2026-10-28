import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Fixed, throwaway test bindings. They override wrangler.jsonc vars and .dev.vars so the suite
// behaves the same locally and in CI. Secrets are 32 bytes, base64url.
const TEST_BINDINGS = {
  ENVIRONMENT: "test",
  APP_ORIGIN: "https://pm.test",
  ADMIN_EMAIL: "owner@example.test",
  EMAIL_FROM: "Password Manager <no-reply@pm.test>",
  AUTH_PEPPER: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  FAKE_SALT_KEY: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
  SERVER_ENC_KEY: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
};

export default defineConfig(async () => {
  // Every migration in ./migrations is applied to the local D1 before tests (see test/setup.ts).
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { ...TEST_BINDINGS, TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});

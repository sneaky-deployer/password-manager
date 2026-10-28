import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { type Env, getConfig } from "../src/env.ts";
import { AppError } from "../src/lib/errors.ts";
import { readJson, TEST_ORIGIN } from "./helpers.ts";

/** A fresh env object (getConfig caches per object) with some fields replaced. */
function withEnv(overrides: Partial<Record<keyof Env, unknown>>): Env {
  return { ...env, ...overrides } as Env;
}

function misconfigured(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "server_misconfigured", status: 503 });
    return;
  }
  throw new Error("expected getConfig to throw");
}

describe("getConfig", () => {
  it("decodes the 32-byte secrets and parses the numeric vars", () => {
    const config = getConfig(withEnv({}));
    expect(config.authPepper).toHaveLength(32);
    expect(config.fakeSaltKey).toHaveLength(32);
    expect(config.serverEncKey).toHaveLength(32);
    expect(config.appOrigin).toBe(TEST_ORIGIN);
    expect(config.rpId).toBe("pm.test");
    expect(config.isProduction).toBe(false);
    expect(config.inviteTtlHours).toBe(72);
    expect(config.kdfDefaultMem).toBe(67108864);
    expect(config.kdfDefaultOps).toBe(3);
  });

  it("is cached per env object", () => {
    const e = withEnv({});
    expect(getConfig(e)).toBe(getConfig(e));
  });

  it.each(["AUTH_PEPPER", "FAKE_SALT_KEY", "SERVER_ENC_KEY"] as const)(
    "fails closed without %s",
    (name) => {
      misconfigured(() => getConfig(withEnv({ [name]: undefined })));
      misconfigured(() => getConfig(withEnv({ [name]: "" })));
    },
  );

  it("fails closed for secrets that are not 32 bytes of base64url", () => {
    misconfigured(() => getConfig(withEnv({ AUTH_PEPPER: "dev-only-auth-pepper-not-a-secret" })));
    misconfigured(() => getConfig(withEnv({ AUTH_PEPPER: "AAECAwQ" }))); // too short
    misconfigured(() => getConfig(withEnv({ AUTH_PEPPER: `${"A".repeat(43)}=` }))); // padding / odd length
    misconfigured(() => getConfig(withEnv({ AUTH_PEPPER: `${"A".repeat(42)}+` }))); // not base64url
  });

  it("fails closed for bad vars", () => {
    misconfigured(() => getConfig(withEnv({ ENVIRONMENT: "prod" })));
    misconfigured(() => getConfig(withEnv({ APP_ORIGIN: "https://pm.test/" })));
    misconfigured(() => getConfig(withEnv({ APP_ORIGIN: undefined })));
    misconfigured(() => getConfig(withEnv({ INVITE_TTL_HOURS: "soon" })));
    misconfigured(() => getConfig(withEnv({ KDF_DEFAULT_MEM: "0" })));
    misconfigured(() => getConfig(withEnv({ EMAIL_FROM: undefined })));
    misconfigured(() => getConfig(withEnv({ ADMIN_EMAIL: "" })));
  });

  it("production needs https and a Resend key; development does not", () => {
    misconfigured(() =>
      getConfig(
        withEnv({
          ENVIRONMENT: "production",
          APP_ORIGIN: "http://pm.test",
          RESEND_API_KEY: "re_x",
        }),
      ),
    );
    misconfigured(() =>
      getConfig(withEnv({ ENVIRONMENT: "production", RESEND_API_KEY: undefined })),
    );
    const prod = getConfig(
      withEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://pm.test", RESEND_API_KEY: "re_x" }),
    );
    expect(prod.isProduction).toBe(true);
    const dev = getConfig(withEnv({ ENVIRONMENT: "development", RESEND_API_KEY: undefined }));
    expect(dev.resendApiKey).toBeUndefined();
  });
});

describe("misconfigured server", () => {
  it("answers 503 server_misconfigured on API routes, without naming the problem", async () => {
    const broken = withEnv({ AUTH_PEPPER: undefined });
    const res = await app.request("/api/nope", {}, broken);
    expect(res.status).toBe(503);
    const body = await readJson<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("server_misconfigured");
    expect(JSON.stringify(body)).not.toContain("AUTH_PEPPER");
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("still serves /api/health so monitoring keeps working", async () => {
    const res = await app.request("/api/health", {}, withEnv({ AUTH_PEPPER: undefined }));
    expect(res.status).toBe(200);
  });
});

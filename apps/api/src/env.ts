import type { Session, User } from "./db/schema.ts";
import { base64urlDecode } from "./lib/crypto.ts";
import { AppError } from "./lib/errors.ts";

/** Worker bindings, vars and secrets (PLAN.md section 19). Vars and secrets are all strings. */
export interface Env {
  // Bindings
  DB: D1Database;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc; .dev.vars overrides them locally)
  APP_ORIGIN: string;
  ENVIRONMENT: string;
  ADMIN_EMAIL: string;
  INVITE_TTL_HOURS: string;
  KDF_DEFAULT_MEM: string;
  KDF_DEFAULT_OPS: string;
  EMAIL_FROM: string;

  // Secrets (dashboard or .dev.vars)
  AUTH_PEPPER: string;
  FAKE_SALT_KEY: string;
  SERVER_ENC_KEY: string;
  /** Required in production; optional in development and tests (emails are not sent there). */
  RESEND_API_KEY?: string;
}

/**
 * Hono generics for the whole app: `new Hono<AppEnv>()`. `c.env` is `Env`; `c.var` holds what the
 * middleware in `app.ts` sets.
 * - `config`: validated config (always set on every /api route except /api/health)
 * - `session` / `user`: set by the session loader when the cookie is valid, else undefined.
 *   Behind `requireAuth` / `requireAdmin` use `getAuth(c)` for non-optional types.
 */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    config: Config;
    session?: Session;
    user?: User;
  };
};

export type Environment = "production" | "development" | "test";

/** Validated, decoded configuration. Build it with `getConfig(env)`; never read `env.*` secrets directly. */
export interface Config {
  environment: Environment;
  isProduction: boolean;
  /** Exact origin of the app, e.g. `https://password-manager.azzaz.dev` (no trailing slash). */
  appOrigin: string;
  /** Hostname of `appOrigin`; the WebAuthn RP ID. */
  rpId: string;
  adminEmail: string;
  inviteTtlHours: number;
  kdfDefaultMem: number;
  kdfDefaultOps: number;
  emailFrom: string;
  /** 32 raw bytes: HMAC key for auth_verifier / recovery_verifier. */
  authPepper: Uint8Array<ArrayBuffer>;
  /** 32 raw bytes: HMAC key for fake prelogin salts. */
  fakeSaltKey: Uint8Array<ArrayBuffer>;
  /** 32 raw bytes: AES-256-GCM key for login TOTP secrets. */
  serverEncKey: Uint8Array<ArrayBuffer>;
  resendApiKey: string | undefined;
}

const ENVIRONMENTS: readonly string[] = ["production", "development", "test"];

function misconfigured(problems: string[]): AppError {
  // Names of the offending variables go to the log (never values); the response stays generic.
  console.error(`server misconfigured: ${problems.join("; ")}`);
  return new AppError("server_misconfigured", 503, "The server is not configured correctly.");
}

function secretBytes(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!raw) return null;
  try {
    const bytes = base64urlDecode(raw);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const cache = new WeakMap<object, Config>();

/**
 * Validates every required var and secret and returns the decoded config. Fails closed: any
 * missing or malformed value throws `AppError("server_misconfigured", 503)`. Cached per `env`.
 */
export function getConfig(env: Env): Config {
  const cached = cache.get(env);
  if (cached) return cached;

  const problems: string[] = [];
  const environment = ENVIRONMENTS.includes(env.ENVIRONMENT)
    ? (env.ENVIRONMENT as Environment)
    : null;
  if (!environment) problems.push("ENVIRONMENT must be production, development or test");
  const isProduction = environment === "production";

  let appOrigin = "";
  let rpId = "";
  try {
    const url = new URL(env.APP_ORIGIN);
    if (url.origin !== env.APP_ORIGIN) throw new TypeError("not a bare origin");
    if (isProduction && url.protocol !== "https:") throw new TypeError("production needs https");
    appOrigin = url.origin;
    rpId = url.hostname;
  } catch {
    problems.push("APP_ORIGIN must be a bare origin (https in production)");
  }

  const adminEmail = (env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!adminEmail.includes("@")) problems.push("ADMIN_EMAIL is missing");

  const inviteTtlHours = positiveInt(env.INVITE_TTL_HOURS);
  if (inviteTtlHours === null) problems.push("INVITE_TTL_HOURS must be a positive integer");
  const kdfDefaultMem = positiveInt(env.KDF_DEFAULT_MEM);
  if (kdfDefaultMem === null) problems.push("KDF_DEFAULT_MEM must be a positive integer");
  const kdfDefaultOps = positiveInt(env.KDF_DEFAULT_OPS);
  if (kdfDefaultOps === null) problems.push("KDF_DEFAULT_OPS must be a positive integer");

  if (!env.EMAIL_FROM) problems.push("EMAIL_FROM is missing");

  const authPepper = secretBytes(env.AUTH_PEPPER);
  if (!authPepper) problems.push("AUTH_PEPPER must be 32 bytes, base64url");
  const fakeSaltKey = secretBytes(env.FAKE_SALT_KEY);
  if (!fakeSaltKey) problems.push("FAKE_SALT_KEY must be 32 bytes, base64url");
  const serverEncKey = secretBytes(env.SERVER_ENC_KEY);
  if (!serverEncKey) problems.push("SERVER_ENC_KEY must be 32 bytes, base64url");

  const resendApiKey = env.RESEND_API_KEY || undefined;
  if (isProduction && !resendApiKey) problems.push("RESEND_API_KEY is missing");

  if (
    problems.length > 0 ||
    !environment ||
    inviteTtlHours === null ||
    kdfDefaultMem === null ||
    kdfDefaultOps === null ||
    !authPepper ||
    !fakeSaltKey ||
    !serverEncKey
  ) {
    throw misconfigured(problems);
  }

  const config: Config = {
    environment,
    isProduction,
    appOrigin,
    rpId,
    adminEmail,
    inviteTtlHours,
    kdfDefaultMem,
    kdfDefaultOps,
    emailFrom: env.EMAIL_FROM,
    authPepper,
    fakeSaltKey,
    serverEncKey,
    resendApiKey,
  };
  cache.set(env, config);
  return config;
}

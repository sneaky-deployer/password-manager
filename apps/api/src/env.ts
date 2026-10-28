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
  RESEND_API_KEY: string;
}

export type AppBindings = { Bindings: Env };

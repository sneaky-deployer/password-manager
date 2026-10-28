import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.ts";
import { AppError } from "../lib/errors.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence (PLAN.md section 8): every state-changing request must carry
 * `Origin === APP_ORIGIN`, exactly. SameSite alone is not enough because sibling subdomains of
 * azzaz.dev are "same-site". Requires `config` middleware to have run.
 */
export const originCheck = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header("Origin") !== c.var.config.appOrigin) {
    throw new AppError("origin_mismatch", 403);
  }
  await next();
});

import { createMiddleware } from "hono/factory";
import { type AppEnv, getConfig } from "../env.ts";

/** Validates vars and secrets and sets `c.var.config`. Throws 503 `server_misconfigured` (fail closed). */
export const loadConfig = createMiddleware<AppEnv>(async (c, next) => {
  c.set("config", getConfig(c.env));
  await next();
});

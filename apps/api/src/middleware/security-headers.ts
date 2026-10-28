import { SECURITY_HEADERS } from "@pm/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.ts";

/** Applies the PLAN.md section 8 headers to every Worker response, including errors. */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.res.headers.set(name, value);
  }
});

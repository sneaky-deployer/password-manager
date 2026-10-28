import { Hono } from "hono";
import type { AppBindings } from "./env.ts";
import { errorHandler, notFoundHandler } from "./middleware/errors.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { health } from "./routes/health.ts";

const api = new Hono<AppBindings>().route("/health", health);

export const app = new Hono<AppBindings>()
  .use(securityHeaders)
  .route("/api", api)
  .onError(errorHandler)
  .notFound(notFoundHandler);

export type AppType = typeof app;

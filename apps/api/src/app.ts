import { Hono } from "hono";
import type { AppEnv } from "./env.ts";
import { errorHandler, notFoundHandler } from "./lib/errors.ts";
import { loadConfig } from "./middleware/config.ts";
import { originCheck } from "./middleware/origin-check.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { sessionLoader } from "./middleware/session.ts";
import { admin } from "./routes/admin.ts";
import { auth } from "./routes/auth.ts";
import { health } from "./routes/health.ts";
import { invites } from "./routes/invites.ts";
import { items } from "./routes/items.ts";
import { me } from "./routes/me.ts";
import { setup } from "./routes/setup.ts";
import { shares } from "./routes/shares.ts";
import { sync } from "./routes/sync.ts";
import { users } from "./routes/users.ts";
import { vaults } from "./routes/vaults.ts";

/**
 * Everything under /api. Order matters (Hono runs handlers in registration order):
 * 1. /health is mounted before the middleware so monitoring works even when config is broken.
 * 2. loadConfig: validates vars/secrets, sets c.var.config (503 server_misconfigured otherwise).
 * 3. originCheck: exact `Origin === APP_ORIGIN` on non-GET/HEAD/OPTIONS (403 otherwise).
 * 4. sessionLoader: sets c.var.session / c.var.user if the cookie is valid. Never rejects; routes
 *    that need a user add `requireAuth` / `requireAdmin` (middleware/session.ts).
 * Security headers (outermost, in `app`) and the error handler wrap all of it.
 */
const api = new Hono<AppEnv>()
  .route("/health", health)
  .use(loadConfig, originCheck, sessionLoader)
  // --- Agent A: accounts. Each file is owned by one agent; app.ts should not need to change. ---
  .route("/setup", setup) // routes/setup.ts
  .route("/invites", invites) // routes/invites.ts
  .route("/auth", auth) // routes/auth.ts
  .route("/me", me) // routes/me.ts
  .route("/admin", admin) // routes/admin.ts
  // --- Agent B: vaults, items, sharing. ---
  .route("/vaults", vaults) // routes/vaults.ts
  .route("/items", items) // routes/items.ts
  .route("/shares", shares) // routes/shares.ts
  .route("/sync", sync) // routes/sync.ts
  .route("/users", users); // routes/users.ts

export const app = new Hono<AppEnv>()
  .use(securityHeaders)
  .route("/api", api)
  .onError(errorHandler)
  .notFound(notFoundHandler);

export type AppType = typeof app;

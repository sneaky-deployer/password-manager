import { app } from "./app.ts";
import type { Env } from "./env.ts";

export type { Env } from "./env.ts";

export default {
  fetch: app.fetch,

  // Daily cleanup (trash purge, expired sessions and codes) arrives in Phase 2+.
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;

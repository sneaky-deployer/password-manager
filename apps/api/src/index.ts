import { app } from "./app.ts";
import { getDb } from "./db/client.ts";
import type { Env } from "./env.ts";
import { runCleanup } from "./jobs/cleanup.ts";

export type { Env } from "./env.ts";

export default {
  fetch: app.fetch,

  // Daily cron (wrangler.jsonc `triggers.crons`): trash purge, expired sessions/codes, old logs.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const result = await runCleanup(getDb(env));
    console.log(`cleanup done: ${JSON.stringify(result)}`);
  },
} satisfies ExportedHandler<Env>;

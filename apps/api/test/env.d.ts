// Types `env` and `exports` from "cloudflare:workers" inside tests.
import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env.ts";
import type * as Main from "../src/index.ts";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      /** Read from ./migrations in vitest.config.ts; applied in test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof Main;
    }
  }
}

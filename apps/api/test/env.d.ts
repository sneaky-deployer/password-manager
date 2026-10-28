// Types `env` and `exports` from "cloudflare:workers" inside tests.
import type { Env as AppEnv } from "../src/env.ts";
import type * as Main from "../src/index.ts";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
    interface GlobalProps {
      mainModule: typeof Main;
    }
  }
}

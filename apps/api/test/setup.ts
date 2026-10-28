import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before every test file. Idempotent: already-applied migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

import { tmpdir } from "node:os";
import { join } from "node:path";

/** Port of the isolated `wrangler dev` the suite starts. Override with E2E_PORT. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8799);
/** The SPA is served by wrangler itself, so the page origin and APP_ORIGIN are the same. */
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
/** Scratch directory (wrangler config, local D1, log). Outside the repo; wiped on every run. */
export const E2E_DIR = process.env.E2E_DIR ?? join(tmpdir(), `pm-e2e-${E2E_PORT}`);
/** wrangler's stdout/stderr, tee'd here. Dev emails (invite links, codes) are read from it. */
export const E2E_LOG = join(E2E_DIR, "wrangler.log");

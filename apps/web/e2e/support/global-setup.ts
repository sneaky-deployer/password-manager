import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_DIR, E2E_LOG, E2E_ORIGIN, E2E_PORT } from "./env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const apiDir = join(repoRoot, "apps/api");
const webDist = join(repoRoot, "apps/web/dist");

// Throwaway secrets (the same values as .dev.vars.example), only used by this isolated local server.
const VARS = {
  APP_ORIGIN: E2E_ORIGIN,
  ENVIRONMENT: "development",
  ADMIN_EMAIL: "admin@e2e.test",
  INVITE_TTL_HOURS: "72",
  KDF_DEFAULT_MEM: "67108864",
  KDF_DEFAULT_OPS: "3",
  EMAIL_FROM: "Password Manager E2E <no-reply@e2e.test>",
  AUTH_PEPPER: "jQ3BDAcJFL1OfX1rIqSWV36ToP5kRd2fXzaGryIYqiY",
  FAKE_SALT_KEY: "IW7r1gsvZYMNG9mVlGAXsuZTt-5AWayT2utQ5eCsiJs",
  SERVER_ENC_KEY: "Brn-OGwRFpqPfMyMqdL8HV-B0dEonCycA3tFLCWcH7M",
};

/**
 * Starts an isolated `wrangler dev` for the whole run: its own config (so the developer's
 * `apps/api/.dev.vars` is never read), its own local D1 in a temp dir, assets from the built SPA.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(
      "apps/web/dist is missing. Build the SPA first: bun run --filter '@pm/web' build",
    );
  }
  rmSync(E2E_DIR, { recursive: true, force: true });
  mkdirSync(E2E_DIR, { recursive: true });

  const configPath = join(E2E_DIR, "wrangler.jsonc");
  const persist = join(E2E_DIR, "state");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "password-manager-e2e",
      main: join(apiDir, "src/index.ts"),
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      assets: {
        directory: webDist,
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: ["/api/*"],
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "password-manager",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: join(apiDir, "migrations"),
        },
      ],
      vars: VARS,
    }),
  );

  // wrangler's package "exports" hide its bin file, so go through its package.json instead.
  const require = createRequire(join(apiDir, "package.json"));
  const wranglerPkg = require("wrangler/package.json") as { bin: Record<string, string> };
  const wranglerBin = join(
    dirname(require.resolve("wrangler/package.json")),
    wranglerPkg.bin.wrangler ?? "bin/wrangler.js",
  );
  const common = ["-c", configPath, "--persist-to", persist];

  const migrate = spawnSync(
    process.execPath,
    [wranglerBin, "d1", "migrations", "apply", "password-manager", "--local", ...common],
    { cwd: apiDir, encoding: "utf8" },
  );
  if (migrate.status !== 0) {
    throw new Error(`D1 migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }

  const log = createWriteStream(E2E_LOG, { flags: "a" });
  const child: ChildProcess = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      ...common,
      "--port",
      String(E2E_PORT),
      "--ip",
      "localhost",
      "--show-interactive-dev-session=false",
    ],
    { cwd: apiDir, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: "pipe" },
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error(`wrangler dev exited early. See ${E2E_LOG}`);
    try {
      const response = await fetch(`${E2E_ORIGIN}/api/health`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`wrangler dev did not become ready in 90 s. See ${E2E_LOG}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return async () => {
    if (exited) return;
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 5000).unref();
    });
    log.end();
  };
}

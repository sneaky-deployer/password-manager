# Password Manager

A multi-user, end-to-end encrypted password manager (storage, generator, TOTP, sharing) that runs
entirely on Cloudflare's free plan. Accounts are invite-only. The server only ever sees ciphertext.

**Read [`PLAN.md`](./PLAN.md) first.** It holds the goals, decisions, security model, cryptography
design, data model, API and the phased build plan. Section 16 shows which phase is current.

## Prerequisites

- [Bun](https://bun.sh) 1.4+ (package manager and script runner)
- Node.js 22+ (Wrangler and Vite run on it)

## Quickstart

```sh
bun install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # throwaway local secrets, gitignored
bun run dev
```

`bun run dev` starts both servers:

| Server                      | URL                   | Role                                                        |
| --------------------------- | --------------------- | ----------------------------------------------------------- |
| Vite (`apps/web`)           | http://localhost:5173 | The app you open in the browser; proxies `/api` to Wrangler |
| `wrangler dev` (`apps/api`) | http://localhost:8787 | Hono API on local workerd with a local D1 database          |

Local D1 migrations: `bun run db:migrate:local`. After changing `apps/api/src/db/schema.ts`, run
`bun run db:generate` to create a migration in `apps/api/migrations/`.

## Commands

| Command                                          | What it does                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `bun run dev`                                    | Vite + `wrangler dev`                                                                        |
| `bun run test`                                   | Vitest in every workspace (the API tests run inside workerd with a local D1)                 |
| `bun run lint`                                   | Biome lint + format check                                                                    |
| `bun run format`                                 | Biome fix (format, safe lint fixes, organize imports)                                        |
| `bun run typecheck`                              | `tsc` in every workspace                                                                     |
| `bun run build`                                  | Build the SPA to `apps/web/dist`, then bundle the Worker (`wrangler deploy --dry-run`)       |
| `bun run db:generate`                            | drizzle-kit: generate a migration from the schema                                            |
| `bun run db:migrate:local` / `db:migrate:remote` | Apply D1 migrations locally / to production                                                  |
| `bun run deploy`                                 | Fallback manual deploy (build, remote migrations, `wrangler deploy`); needs `wrangler login` |

End-to-end tests (Playwright, run in CI by `.github/workflows/e2e.yml`): `bunx playwright install chromium`
once, then `bun run test:e2e` from the repo root. It builds the SPA, starts an isolated `wrangler dev`
(own config, own local D1 in a temp dir, throwaway secrets; your `apps/api/.dev.vars` is not used) and
drives real Chromium through the main journeys with two browser contexts. Dev emails (invite links,
email codes) are read from wrangler's log. The specs in `apps/web/e2e` are ordered journeys that share
one server, so run them together. If Chromium is installed elsewhere, set
`PW_CHROMIUM_EXECUTABLE=/path/to/chrome`; `E2E_PORT` changes the port (default 8799).

## Layout

```
apps/api       Hono API on Cloudflare Workers (+ D1 via Drizzle)
apps/web       React + Vite SPA
packages/*     crypto, generator, otp, shared (consumed as TypeScript source, no build step)
```

Workspace packages are imported as `@pm/<name>`. Production code in `apps/api` and `packages/*`
uses Web-standard APIs only, so it runs on `workerd`.

## Deploying

Pushes to `master` run `.github/workflows/deploy.yml`: install, lint, typecheck, test, build, apply
D1 migrations, then `wrangler deploy` to https://password-manager.azzaz.dev. The deploy steps are
skipped (with a notice) until all of these exist:

- GitHub secret `CLOUDFLARE_API_TOKEN` and variable `CLOUDFLARE_ACCOUNT_ID`
- the real D1 `database_id` in `apps/api/wrangler.jsonc` (it holds a placeholder for now)

Worker secrets (`AUTH_PEPPER`, `FAKE_SALT_KEY`, `SERVER_ENC_KEY`, `RESEND_API_KEY`) are set in the
Cloudflare dashboard, never in the repo. The one-time owner setup is in `PLAN.md` section 18, the
configuration reference in section 19.

Pull requests and branch pushes run `.github/workflows/ci.yml` (the same checks, no deploy).

## Security headers

The headers from `PLAN.md` section 8 come from `SECURITY_HEADERS` in `packages/shared`. The Worker
middleware applies them to `/api/*` responses; `apps/web/public/_headers` applies the same values to
static assets (Workers static assets support `_headers`). A test in `apps/web` fails if they drift.

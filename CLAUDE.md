# CLAUDE.md

This repo is a **multi-user, end-to-end encrypted password manager** (like Proton Pass): password storage, a strong password generator, TOTP codes with a live countdown, and sharing between users. It runs entirely on Cloudflare's free plan: one Worker (Hono API + React SPA as static assets) with D1 (SQLite). Bun is the package manager and workspace tool.

**Read `PLAN.md` before doing anything.** It holds the goals, decisions and why they were made, the security model, the cryptography design, the data model, the API, and the phased build plan with checklists. Section 16 shows which phase is current.

Hard rules (details in `PLAN.md` section 21):
- The server never receives plaintext secrets or keys. All crypto lives in `packages/crypto`.
- Never change a ciphertext format, AAD string or KDF context in place; add a new version.
- No password hashing on the server (Workers free plan has a 10 ms CPU limit). Argon2id runs in the browser.
- Use `batch()` for D1; never query in a loop.
- Web-standard APIs only in `apps/api` and `packages/*`.
- Never log or commit secrets, `.dev.vars`, database files, backups or real user data.
- Update `PLAN.md` (checkboxes, decisions) in the same commit as the work.

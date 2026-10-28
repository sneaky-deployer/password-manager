# Password Manager: Project Plan

This document is the single source of truth for the project. It is written so that someone (a person or a new AI session) with **no prior context** can read it top to bottom and start working. If you change a decision, update this file in the same commit.

**Status:** planning complete, no code yet. Next step: **Phase 0** (see [Build phases](#16-build-phases)).

---

## Table of contents

1. [What we are building](#1-what-we-are-building)
2. [Guiding principles](#2-guiding-principles)
3. [Key decisions and their rationale](#3-key-decisions-and-their-rationale)
4. [The $0 budget: free-plan limits we design around](#4-the-0-budget-free-plan-limits-we-design-around)
5. [Architecture overview](#5-architecture-overview)
6. [Tech stack](#6-tech-stack)
7. [Repository layout](#7-repository-layout)
8. [Security model](#8-security-model)
9. [Cryptography design](#9-cryptography-design)
10. [Account flows: signup, login, unlock, password change, recovery](#10-account-flows-signup-login-unlock-password-change-recovery)
11. [Sharing](#11-sharing)
12. [Data model (D1)](#12-data-model-d1)
13. [HTTP API](#13-http-api)
14. [Feature specs: items, password generator, TOTP](#14-feature-specs-items-password-generator-totp)
15. [Frontend architecture](#15-frontend-architecture)
16. [Build phases](#16-build-phases)
17. [Testing strategy](#17-testing-strategy)
18. [Deployment, operations and backups](#18-deployment-operations-and-backups)
19. [Configuration reference](#19-configuration-reference)
20. [Open questions for the owner](#20-open-questions-for-the-owner)
21. [Conventions for contributors and AI sessions](#21-conventions-for-contributors-and-ai-sessions)
22. [Glossary](#22-glossary)

---

## 1. What we are building

A **multi-user, end-to-end encrypted password manager** in the style of Proton Pass or Bitwarden, delivered as a web app (SPA). It must run on **free plans only** ($0/month).

### Core features (MVP)

| # | Feature | Summary |
|---|---------|---------|
| 1 | **Accounts** | Users sign up with email + master password. Each user has their own encrypted vault(s). |
| 2 | **Secure storage** | Logins (username, password, URLs, notes, custom fields), secure notes. Everything is encrypted in the browser before it reaches the server. |
| 3 | **Strong password generator** | Random-character passwords and word-based passphrases, generated with a cryptographically secure RNG, with a strength/entropy readout. |
| 4 | **TOTP authenticator** | Store 2FA secrets (from `otpauth://` URIs or QR codes) inside items. Show the current code with a **live countdown** that regenerates at the end of each period (30 s, 60 s, or whatever the site uses). |
| 5 | **Sharing** | Share a whole vault or a single item with other registered users, with roles (viewer, editor, manager). Revoke access at any time. |
| 6 | **Account security** | Login 2FA for the app itself (TOTP and passkeys/WebAuthn), backup codes, session management, auto-lock. |
| 7 | **Recovery** | Change master password instantly; recover a forgotten master password with a **recovery kit** (24-word phrase) without losing data. |

### Later features (post-MVP, see Phase 7)

Password health (weak/reused), breach check (Have I Been Pwned k-anonymity API), import/export from other managers, passkey-based unlock (WebAuthn PRF), emergency access, public-key fingerprint verification, browser extension, installable PWA with offline read access, Google Authenticator export import, card and identity item types.

### Non-goals (for now)

- Native mobile apps. The SPA must work well on mobile browsers.
- File attachments (would need R2 and bigger storage; maybe later).
- Organisations/teams billing, SSO, admin consoles.
- Autofill inside other websites (needs a browser extension, Phase 7).
- Paid infrastructure of any kind.

---

## 2. Guiding principles

1. **Zero-knowledge / end-to-end encryption.** The server never sees master passwords, item contents, TOTP secrets, vault names or any decryption key. It stores ciphertext and the minimum metadata needed to run (emails, timestamps, who shares with whom). A full database leak must not reveal vault contents.
2. **Don't invent crypto.** Use well-reviewed primitives from libsodium. Our job is a correct key hierarchy, not new algorithms.
3. **$0 to run.** Every design choice must fit Cloudflare's free Workers plan (see [section 4](#4-the-0-budget-free-plan-limits-we-design-around)).
4. **Boring and small.** Few dependencies, especially in the browser bundle, because every dependency in a password manager's frontend is part of the attack surface.
5. **Honesty in the UI.** Users are told clearly that a forgotten master password without a recovery kit means lost data, and that revoking a share cannot "un-see" passwords the other person already viewed.

---

## 3. Key decisions and their rationale

| Decision | Choice | Why | Rejected alternatives |
|----------|--------|-----|-----------------------|
| Encryption model | End-to-end, all crypto in the browser | Matches Proton Pass/Bitwarden; a server or DB breach doesn't expose secrets | Server-side encryption (server would hold keys, so a breach exposes everything) |
| Language | TypeScript everywhere | The security-critical code runs in the browser, so it must be TS. Sharing schemas and crypto code with the server avoids drift. A future browser extension reuses the same packages | Laravel + React SPA (two languages, schemas defined twice, heavier PHP hosting); Laravel + Livewire (server-rendered, so the server would see plaintext: incompatible with E2E) |
| Monorepo tooling | **Bun** workspaces | Fast installs and scripts; owner preference | npm/pnpm workspaces |
| API framework | **Hono** | Tiny, typed, Web-standard APIs; runs on Workers, Bun, Node and Fly unchanged | Express (Node-specific, larger, doesn't run on Workers natively) |
| Hosting | **One Cloudflare Worker** serving both the API (`/api/*`) and the SPA (static assets) | Free plan, one origin (no CORS, simple cookies), static asset requests are free | Cloudflare Pages + Fly.io (Fly has no free tier for new accounts since Oct 2024; two origins); Cloudflare Pages (Cloudflare now steers new projects to Workers static assets) |
| Production runtime | Cloudflare `workerd` (not Bun) | That's what the free plan runs. Bun is used for local tooling only | Bun on Fly.io (costs money) |
| Database | **Cloudflare D1** (SQLite) | Free, same account, no cold starts, no connection pooling, 7-day point-in-time restore. Encrypted blobs need nothing Postgres-specific | Supabase free (pauses after ~7 days idle and stays offline until manually restored); Neon free (works, but a second vendor and cold starts) |
| ORM / query builder | **Drizzle** + drizzle-kit migrations | First-class D1 support, light, fast startup, typed | Prisma (heavier; D1 support via adapter) |
| Crypto library | **libsodium** (`libsodium-wrappers-sumo`, the "sumo" build is needed for Argon2id) | Audited, one library for KDF, AEAD, key exchange; WASM | Hand-rolled WebCrypto for everything (no Argon2 in WebCrypto) |
| Password KDF | **Argon2id**, 64 MiB, 3 iterations, run in the browser | Memory-hard; the slow part runs on the client so the server stays within the 10 ms CPU limit | PBKDF2 (weaker against GPUs); server-side Argon2/bcrypt (exceeds the free 10 ms CPU limit) |
| Server-side verifier | `HMAC-SHA256(pepper, authKey)` | The input is a 256-bit derived key, not a human password, so a fast keyed hash is safe and fits 10 ms CPU | Argon2/bcrypt on the server |
| TOTP | `otpauth` library, computed in the browser | Supports SHA1/256/512, 6–8 digits, any period; secrets never leave the client unencrypted | Server-side TOTP generation (server would need secrets) |
| Recovery phrase encoding | BIP39 24 words via `@scure/bip39` | Well-known, has a checksum, audited, tiny | Custom word encoding |
| Frontend | React + Vite SPA, TanStack Query, TanStack Router, Tailwind CSS | Common, well-documented, fast builds | Next.js / SSR (unnecessary; server can't render decrypted data anyway) |
| Email sending | **Resend** free tier (or Cloudflare's own email sending if it's free and available when we reach Phase 2) | Needed for verification and recovery codes; free tier covers a small user base | Self-hosted SMTP |
| Backups | GitHub Actions scheduled job: `wrangler d1 export` → encrypt with `age` → upload to **R2** | Free (Actions + R2 free tier); off-platform copy beyond D1's 7-day restore window | Upstash QStash (would still need somewhere to run `pg_dump`/export) |
| Scheduled jobs | Workers **Cron Triggers** in the same Worker | Free; used for purging trash, expired sessions and codes | External cron services |
| Lint/format | **Biome** | One fast tool for both | ESLint + Prettier |
| Tests | **Vitest** (+ `@cloudflare/vitest-pool-workers` for the API), **Playwright** for E2E | Vitest is what Cloudflare's Workers test pool uses; one test runner everywhere | `bun test` (doesn't run inside workerd) |

---

## 4. The $0 budget: free-plan limits we design around

Figures checked in October 2026. Re-check Cloudflare's docs if something looks off.

| Resource | Free limit | How we stay within it |
|----------|-----------|-----------------------|
| Worker requests | 100,000 / day (resets 00:00 UTC) | Static asset requests are free and don't invoke the Worker (`run_worker_first` only for `/api/*`). One sync call on unlock, incremental after |
| **Worker CPU time** | **10 ms per request** (network/D1 wait time doesn't count) | **No password hashing on the server.** Argon2id runs in the browser. Server only does HMAC/SHA-256, JSON, D1 queries. Keep handlers simple |
| Worker memory | 128 MB | Small responses; paginate large vaults |
| Subrequests | 50 per request | Only email sending uses `fetch` |
| D1 queries | 50 per Worker invocation | Use `db.batch([...])`; never query in a loop |
| D1 rows read / written | ~5M reads, ~100k writes per day | Index lookups; incremental sync by `updated_at` |
| D1 storage | 500 MB per DB, 5 GB per account, 10 DBs | Encrypted items are ~1–5 KB; 500 MB ≈ 100k+ items. Cap item plaintext at 64 KB |
| D1 Time Travel | 7 days point-in-time restore | Plus daily off-platform backups to R2 |
| D1 transactions | No interactive transactions; `batch()` is atomic | All multi-row writes (password change, key rotation) go through one `batch()` |
| Cron Triggers | Available on free | One daily cleanup job |
| R2 | 10 GB storage, 1M Class A ops/month | Daily backup, keep 30 days via lifecycle rule |
| GitHub Actions | Free for public repos; 2,000 min/month private | CI + daily backup job ≈ a few hundred minutes/month |
| Resend | ~3,000 emails/month, 100/day | Emails only for verification and recovery codes |
| Domain | `*.workers.dev` subdomain is free | Custom domain optional (costs money for the domain itself) |

When a daily D1 limit is exceeded, queries fail until 00:00 UTC. For a small user group this won't happen; the API must still return a clear error (`503`, code `quota_exceeded`) rather than crash.

---

## 5. Architecture overview

```
                       Browser (the only place plaintext exists)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ React SPA                                                              │
 │  ├─ UI (vault list, item editor, generator, TOTP widget, sharing)      │
 │  ├─ Crypto Web Worker  ── libsodium (Argon2id, XChaCha20-Poly1305,     │
 │  │                         X25519 sealed boxes), keys held in memory   │
 │  └─ API client (fetch, same-origin cookie session)                     │
 └───────────────────────────────┬───────────────────────────────────────┘
                                 │ HTTPS, same origin
 ┌───────────────────────────────▼───────────────────────────────────────┐
 │ Cloudflare Worker (single deployment)                                  │
 │  ├─ Static assets: SPA build (free, Worker not invoked)                │
 │  ├─ /api/*  Hono app: auth, sessions, vaults, items, shares            │
 │  │          sees only ciphertext + metadata                            │
 │  └─ scheduled(): daily cleanup (trash purge, expired sessions/codes)   │
 └──────────────┬───────────────────────────────────┬────────────────────┘
                │ D1 binding                        │ fetch
        ┌───────▼────────┐                  ┌───────▼────────┐
        │ Cloudflare D1  │                  │ Resend (email) │
        │ (SQLite)       │                  └────────────────┘
        └───────▲────────┘
                │ wrangler d1 export (daily, GitHub Actions)
        ┌───────┴────────┐
        │ Cloudflare R2  │  age-encrypted backups, 30-day retention
        └────────────────┘
```

**Bun's role:** package manager, workspace runner, local scripts (`bun run dev`, `bun run test`). Production code in `apps/api` and `packages/*` must use **Web-standard APIs only** (no `Bun.*`, no Node built-ins unless Workers' `nodejs_compat` covers them) so it runs on `workerd`. If a tool misbehaves under Bun (e.g. a Wrangler edge case), fall back to Node LTS for that one tool.

---

## 6. Tech stack

Use the latest stable versions at the time of scaffolding and pin them in `bun.lock`.

| Area | Package(s) |
|------|-----------|
| Runtime/tooling | Bun, TypeScript (strict), Wrangler |
| API | `hono`, `zod`, `@hono/zod-validator`, `drizzle-orm`, `drizzle-kit` |
| Auth extras (server) | `@simplewebauthn/server` (passkeys; confirm it runs on Workers during Phase 5), `otpauth` (login 2FA verification) |
| Frontend | `react`, `react-dom`, `vite`, `@tanstack/react-query`, `@tanstack/react-router`, `tailwindcss` |
| Frontend crypto | `libsodium-wrappers-sumo`, `@scure/bip39`, `otpauth` |
| Frontend extras | `@simplewebauthn/browser`, `jsqr` (QR decode fallback when `BarcodeDetector` is unavailable), `@zxcvbn-ts/core` + `@zxcvbn-ts/language-common` (strength estimate of user-typed passwords) |
| Lint/format | `@biomejs/biome` |
| Tests | `vitest`, `@cloudflare/vitest-pool-workers`, `@playwright/test` |

Rules: no analytics, no third-party scripts, no CDNs at runtime. Everything is bundled and served from our origin.

---

## 7. Repository layout

```
password-manager/
├── PLAN.md                     # this file
├── CLAUDE.md                   # short pointer for AI sessions
├── README.md                   # quickstart (created in Phase 0)
├── package.json                # bun workspaces root, shared scripts
├── bun.lock
├── biome.json
├── tsconfig.base.json
├── apps/
│   ├── web/                    # React SPA (Vite)
│   │   ├── src/
│   │   │   ├── crypto-worker/  # Web Worker wrapping packages/crypto
│   │   │   ├── features/       # auth, vault, items, generator, totp, sharing, settings
│   │   │   ├── lib/            # api client, session/lock state
│   │   │   └── routes/
│   │   └── e2e/                # Playwright tests
│   └── api/                    # Hono app on Cloudflare Workers
│       ├── src/
│       │   ├── index.ts        # fetch + scheduled handlers
│       │   ├── routes/         # auth, me, vaults, items, shares, users
│       │   ├── db/schema.ts    # Drizzle schema
│       │   ├── middleware/     # session, csrf/origin check, rate limit, errors
│       │   └── lib/            # hmac, tokens, email, totp-login, webauthn
│       ├── migrations/         # drizzle-kit generated SQL for D1
│       ├── test/
│       ├── wrangler.jsonc
│       └── .dev.vars.example   # never commit .dev.vars
├── packages/
│   ├── crypto/                 # key hierarchy, envelopes, sealing, recovery phrase. ONLY place crypto lives
│   ├── generator/              # password + passphrase generator (EFF large wordlist)
│   ├── otp/                    # otpauth URI parsing, code + countdown helpers
│   └── shared/                 # zod schemas, API types, constants, item model
├── scripts/                    # backup/restore helpers
└── .github/workflows/
    ├── ci.yml                  # lint, typecheck, unit tests, build
    ├── deploy.yml              # migrations + wrangler deploy on push to master
    └── backup.yml              # daily D1 export → age → R2
```

---

## 8. Security model

### What we protect against

| Threat | Mitigation |
|--------|-----------|
| Database leak (D1 export stolen) | Items, vault names and private keys are ciphertext. Login verifiers are HMACs keyed with a pepper stored as a Worker secret, not in the DB. Even with the pepper, each password guess costs a full Argon2id run |
| Server operator / compromised API reading data | Server never receives plaintext or keys |
| Network attacker | HTTPS only, HSTS, `__Host-` cookies |
| XSS stealing keys | Strict CSP, no third-party scripts, React escaping, no `dangerouslySetInnerHTML`, keys live in a Web Worker and never in `localStorage`/`sessionStorage` |
| CSRF | `SameSite=Strict` cookie, same origin, `Origin` header check on all non-GET requests |
| Online password guessing | Rate limits per email and per IP, login 2FA |
| Ciphertext swapping (server moves item A's ciphertext onto item B) | Every ciphertext is bound to its ID with AEAD associated data (AAD) |
| Stolen session cookie | Still needs the master password to decrypt (keys are not in the session). Sessions listable and revocable; idle and absolute expiry |
| User enumeration | `prelogin` returns a deterministic fake salt for unknown emails; identical error messages |

### Known limitations (accepted, documented)

- **A malicious server could serve a fake public key** when you share with someone, so the share would go to the attacker. Mitigation in Phase 7: show key fingerprints that users can compare out-of-band. Bitwarden has the same limitation.
- **A malicious server could serve modified JavaScript.** This is inherent to all web-based password managers. A browser extension (Phase 7) reduces it.
- **Revocation can't erase what was already seen.** A revoked user may have copied passwords. The UI recommends changing the actual passwords after revoking.
- **Metadata is visible to the server:** emails, item counts and sizes, timestamps, the sharing graph, IP addresses (via Cloudflare).
- **Forgetting the master password without a recovery kit and without a signed-in device means the data is gone.** This is a property of E2E encryption, not a bug.

### HTTP security headers (set by the Worker on every response, including assets)

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'; form-action 'self'
Strict-Transport-Security: max-age=63072000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self), clipboard-write=(self), geolocation=(), microphone=()
Cross-Origin-Opener-Policy: same-origin
```

(`wasm-unsafe-eval` is required for libsodium's WASM. Camera is for QR scanning.)

---

## 9. Cryptography design

All crypto code lives in `packages/crypto`. Nothing else may call libsodium directly.

### 9.1 Primitives

| Purpose | Primitive (libsodium name) |
|---------|---------------------------|
| Password → key | Argon2id: `crypto_pwhash` with `ALG_ARGON2ID13`, memlimit 64 MiB, opslimit 3, 32-byte output, 16-byte salt |
| Subkey derivation | `crypto_kdf_derive_from_key` (BLAKE2b) with an 8-char context |
| Symmetric encryption | XChaCha20-Poly1305: `crypto_aead_xchacha20poly1305_ietf_*`, 24-byte random nonce, with AAD |
| Public-key encryption | X25519 sealed boxes: `crypto_box_seal` / `crypto_box_seal_open` |
| Randomness | `randombytes_buf` / `crypto.getRandomValues` |
| Server-side verifier | HMAC-SHA256 via WebCrypto in the Worker |

KDF parameters are stored **per user** (`kdf_mem`, `kdf_ops`), so we can raise them later. When a user unlocks with weaker-than-current parameters, the client silently re-wraps the account key with new parameters (same flow as a password change, with the same password).

### 9.2 Key hierarchy

```
master password ─┐
salt (16 B, random, per user, public) ─┴─ Argon2id ──► passwordKey (32 B, never leaves the browser, never stored)
                                                          │
                     crypto_kdf ctx "PMKEYS01" ┌──────────┴──────────┐
                                        id=1   ▼                     ▼  id=2
                                           authKey               wrapKey
                                   (sent to server at login)  (encrypts the account key)
                                                                     │
                                ACCOUNT KEY  AK (32 B random, created once at signup, never changes
                                             unless the user explicitly rotates keys)
                                 ├── encrypts ──► identity private key (X25519)
                                 └── (public key stored in plaintext on the server)

 identity keypair ── sealed box ──► VAULT KEY VK (32 B random per vault, per key version)
                                       └── encrypts ──► vault metadata (name, icon, colour)
                                       └── encrypts ──► ITEM KEY IK (32 B random per item)
                                                            └── encrypts ──► item content

 recovery phrase (24 words = 32 B entropy) ── crypto_kdf ctx "PMRECV01"
        ├─ id=1 ► recoveryAuthKey (proves possession to the server)
        └─ id=2 ► recoveryWrapKey ── encrypts a second copy of AK
```

Why the extra layers:
- **AK** decouples the password from the data: changing the password re-wraps one 32-byte key, nothing else.
- **VK per vault** makes sharing a vault = giving someone VK.
- **IK per item** makes sharing a single item = giving someone IK, without exposing the rest of the vault.
- Every member (including the owner) receives VK/IK as a **sealed box to their own public key**, so "my own vault" and "a vault shared with me" use the same code path.

### 9.3 Ciphertext envelope format

All symmetric ciphertexts are stored as a base64url string of:

```
[1 byte format version = 0x01][24 byte nonce][ciphertext + 16 byte Poly1305 tag]
```

Sealed boxes are stored as base64url of libsodium's sealed-box output; the sealed plaintext is JSON so the recipient can check what it is:

```json
{ "v": 1, "type": "vault", "id": "<vaultId>", "keyVersion": 3, "key": "<base64url 32 bytes>" }
{ "v": 1, "type": "item",  "id": "<itemId>",  "keyVersion": 1, "key": "<base64url 32 bytes>" }
```

The client **must** reject a sealed key whose `type`/`id`/`keyVersion` doesn't match the record it came with.

### 9.4 Associated data (AAD) strings

AAD binds each ciphertext to its place, so the server can't swap ciphertexts around. All IDs are generated **client-side** (UUID v4) so the AAD can be computed before upload.

| Ciphertext | Key | AAD |
|-----------|-----|-----|
| Wrapped AK (password) | wrapKey | `pm:v1:ak:pw:{userId}` |
| Wrapped AK (recovery) | recoveryWrapKey | `pm:v1:ak:rec:{userId}` |
| Encrypted private key | AK | `pm:v1:privkey:{userId}` |
| Vault metadata | VK | `pm:v1:vaultmeta:{vaultId}:{keyVersion}` |
| Wrapped item key | VK | `pm:v1:itemkey:{vaultId}:{itemId}:{vaultKeyVersion}` |
| Item content | IK | `pm:v1:item:{itemId}:{itemKeyVersion}` |

Changing any format means bumping the version prefix (`v2`) and keeping the decoder for `v1`.

### 9.5 What the server stores per user (none of it is secret on its own)

`kdf_salt`, `kdf_mem`, `kdf_ops`, `auth_verifier = HMAC(AUTH_PEPPER, authKey)`, `wrapped_ak_pw`, `wrapped_ak_rec`, `recovery_verifier = HMAC(AUTH_PEPPER, recoveryAuthKey)`, `public_key`, `encrypted_private_key`.

### 9.6 Rules for `packages/crypto`

- Pure functions, no network, no DOM. Runs in a Web Worker and in Vitest.
- Zero keys outside the worker: the UI thread gets decrypted item objects, never raw keys.
- Use `sodium.memzero` on key buffers when locking (best effort; JS can't guarantee it).
- Fixed test vectors in `packages/crypto/test/vectors.json` so any accidental format change fails tests.

---

## 10. Account flows: signup, login, unlock, password change, recovery

### 10.1 Signup

1. User enters email. `POST /api/auth/email/start {email, purpose:"signup"}` sends a 6-digit code (valid 15 min, 5 attempts). This proves they own the email before an account exists.
2. User enters the code, a master password (minimum 12 characters, zxcvbn score ≥ 3, with a clear explanation that it can't be reset by us), and confirms it.
3. In the crypto worker the client:
   1. generates `userId`, `salt`, derives `passwordKey` → `authKey`, `wrapKey`;
   2. generates `AK`, identity keypair; encrypts private key with AK; wraps AK with wrapKey;
   3. generates the recovery phrase (32 random bytes → 24 BIP39 words), derives `recoveryAuthKey`, `recoveryWrapKey`; wraps AK with recoveryWrapKey;
   4. creates the default vault "Personal": `vaultId`, `VK`, encrypted metadata, VK sealed to the user's own public key.
4. `POST /api/auth/signup` with the email code and all of the above. The server stores HMACs of `authKey` and `recoveryAuthKey`, creates the user, vault and membership in one `batch()`, and starts a session.
5. **Recovery kit screen** (cannot be skipped): show the 24 words, offer "Download recovery kit" (a text/PDF file with the words, email and instructions), and ask the user to type 3 randomly chosen words to confirm they saved it.

### 10.2 Login

1. `POST /api/auth/prelogin {email}` → `{kdf: {alg, mem, ops}, salt}`. Unknown emails get `salt = HMAC(FAKE_SALT_KEY, email)[0..16]` and default params, so responses look the same.
2. Client derives `passwordKey` → `authKey` (Argon2id takes ~0.5–1.5 s; show a spinner, it runs in the worker).
3. `POST /api/auth/login {email, authKey}`. Server computes `HMAC(AUTH_PEPPER, authKey)` and compares in constant time.
   - Wrong: `401 invalid_credentials` (same message for unknown email), count towards rate limit.
   - Right, 2FA off: create session, return the key bundle (see unlock).
   - Right, 2FA on: return `{twoFactorRequired: true, methods: [...], challengeToken}` (random, 5 min, stored hashed). Then `POST /api/auth/2fa/verify {challengeToken, totp | webauthnAssertion | backupCode}` creates the session.
4. Client unwraps AK with `wrapKey`, decrypts the private key, then syncs vaults.

**Sessions:** cookie `__Host-pm_session` (HttpOnly, Secure, SameSite=Strict, Path=/), value = 32 random bytes base64url. DB stores only `SHA-256(token)`. Idle expiry 30 days, absolute 90 days. Each user has a `security_stamp`; sessions created before the current stamp are invalid. Bumping the stamp logs out everywhere.

### 10.3 Lock and unlock

- **Lock** = the crypto worker drops all keys. The session cookie stays. Auto-lock after N minutes idle (default 15, configurable), on manual lock, and on page reload (keys are only in memory).
- **Unlock** = `GET /api/me/keys` (requires session) returns salt, KDF params, `wrapped_ak_pw`, `encrypted_private_key`, `public_key`. Client derives `wrapKey` from the typed password and decrypts. A wrong password fails AEAD decryption locally; no server call needed. Unlock is rate-limited in the UI with exponential backoff.
- Phase 7: unlock with a passkey using the WebAuthn PRF extension (AK additionally wrapped with a PRF-derived key).

### 10.4 Change master password (user knows the current one)

1. User enters the current and new password.
2. Client derives the old `wrapKey`, unwraps AK (this proves the old password locally).
3. Client generates a **new salt**, derives the new `passwordKey` → new `authKey`, new `wrapKey`; re-wraps AK.
4. `POST /api/me/password {currentAuthKey, newSalt, newKdf, newAuthKey, newWrappedAk}`. Server verifies `currentAuthKey`, then in one `batch()` updates salt, KDF params, verifier and wrapped AK, bumps `security_stamp` (logs out other devices) and issues a fresh session for this device.

**No item is re-encrypted.** It's instant regardless of vault size, and shares are unaffected. The recovery phrase keeps working because it wraps the same AK.

### 10.5 Forgot master password

The server can't reset the password and keep the data, because it never had the keys. An email-only reset that kept data would mean anyone with access to the user's inbox (or the server) could read every password. Paths, in order of preference:

**A. Recovery kit (main path, data kept)**
1. "Forgot password" → enter email → email code (`purpose:"recovery"`).
2. Enter the 24-word phrase. Client derives `recoveryAuthKey`, `recoveryWrapKey`.
3. If 2FA is enabled, also require a 2FA code or a backup code.
4. `POST /api/auth/recovery/start {email, emailCode, recoveryAuthKey, twoFactor?}` → server verifies and returns `{userId, wrapped_ak_rec, recoveryToken}` (10 min).
5. Client unwraps AK, user chooses a new password, client builds the new salt/verifier/wrapped AK as in 10.4.
6. `POST /api/auth/recovery/complete {recoveryToken, newSalt, newKdf, newAuthKey, newWrappedAk}`. Server updates, bumps `security_stamp`, emails a "your password was reset via recovery kit" notice.
7. Prompt the user to **generate a new recovery kit** (old phrase stays valid until they do; regenerating replaces `wrapped_ak_rec` and `recovery_verifier`).

**B. A device that is still unlocked (data kept)**
If the vault is unlocked on another device, the user goes to Settings → Change password there. That device holds AK in memory, so it can set a new password without the old one (it still requires a recent email code to confirm). Endpoint: `POST /api/me/password/reset-from-unlocked {emailCode, newSalt, newKdf, newAuthKey, newWrappedAk}`.

**C. Emergency contact (Phase 7, data kept)**
A trusted user receives AK sealed to their public key, usable only after a waiting period (e.g. 7 days) that the owner can cancel from any device.

**D. Reset account (last resort, data lost)**
Email code → confirm a clear warning ("All your items will be permanently deleted. Items others shared with you will need to be re-shared.") → new keys and a new empty vault are generated, all owned vaults/items are deleted, memberships in others' vaults are removed, 2FA and passkeys are cleared, sessions are revoked.

### 10.6 Login 2FA (for the app itself)

This protects **sign-in**, not encryption. Losing it never risks data.

- **TOTP:** server generates the secret, shows QR, user confirms a code. Secret stored encrypted with `SERVER_ENC_KEY` (AES-256-GCM via WebCrypto). Accept ±1 step; store the last accepted step to block replay.
- **Passkeys (WebAuthn):** register/remove multiple; used as a second factor (and later for unlock via PRF).
- **Backup codes:** 10 single-use codes, shown once, stored as `SHA-256(code)`.

### 10.7 Key rotation (explicit, rare)

"Rotate my keys" in settings (for a suspected compromise): new AK and identity keypair, re-seal every VK/IK the user holds, re-wrap with password and recovery keys (requires the recovery phrase to be regenerated). Done client-side, uploaded in batched requests, finalised in one `batch()`.

---

## 11. Sharing

Only registered users with verified emails can share or receive shares.

### 11.1 Roles

| Role | Vault share | Item share |
|------|------------|-----------|
| `viewer` | Read all items | Read the item |
| `editor` | Read + create/edit/trash items | Read + edit the item |
| `manager` | Editor + invite/remove members | n/a |
| `owner` | Manager + delete vault, transfer ownership | (item owner = vault owner) |

The server enforces roles on writes (it decides who may upload ciphertext). Reads are enforced by only returning ciphertext to members.

### 11.2 Share a vault

1. Sharer types the recipient's email. `GET /api/users/lookup?email=` → `{userId, publicKey}` (rate-limited; only for logged-in, verified users).
2. Client seals `{type:"vault", id, keyVersion, key: VK}` to the recipient's public key.
3. `POST /api/vaults/:id/members {userId, role, sealedKey}` → membership with `status:"pending"`.
4. Recipient sees the invite, accepts (`POST /api/shares/:id/accept`) or declines. Accepted vaults appear in their sidebar.

### 11.3 Share a single item

Same flow with `{type:"item", id, keyVersion, key: IK}` and `POST /api/items/:id/shares`. The recipient sees it under "Shared with me". They never get VK, so the rest of the vault stays private.

### 11.4 Revoke

**Vault member removed:**
1. Server deletes the membership immediately (no more ciphertext served to them).
2. Client of the remover rotates: new `VK'` (keyVersion+1), new `IK'` for every item in the vault, re-encrypts item contents and metadata, re-seals `VK'` for every remaining member and the owner, re-seals new item keys for any single-item shares inside the vault.
3. Uploaded in chunks; the final step is one `batch()` that switches the vault's `key_version`. Until the rotation completes, the vault is marked `rotation_pending` and the UI retries.

**Item share removed:** delete the item share, rotate that item's IK, re-encrypt the item, re-wrap IK with VK, re-seal for remaining item-share members.

UI message after any revoke: "They no longer have access. If they viewed these passwords, consider changing them."

### 11.5 Leave / delete

- A member can leave a shared vault at any time (deletes their membership; no rotation needed).
- Deleting a vault deletes its items, memberships and item shares.
- Deleting an account deletes owned vaults (and therefore access for their members, with a warning listing affected people) and removes the user's memberships elsewhere.

---

## 12. Data model (D1)

SQLite via Drizzle. Conventions: IDs are UUID v4 `TEXT` (client-generated for users, vaults and items; server-generated for others). Timestamps are `INTEGER` Unix milliseconds. Binary values are base64url `TEXT`. Foreign keys on, `ON DELETE CASCADE` where noted.

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | client-generated |
| email | TEXT UNIQUE | lowercased, trimmed |
| email_verified_at | INTEGER | |
| kdf_alg | TEXT | `argon2id13` |
| kdf_mem | INTEGER | bytes |
| kdf_ops | INTEGER | |
| kdf_salt | TEXT | |
| auth_verifier | TEXT | HMAC-SHA256 hex |
| wrapped_ak_pw | TEXT | envelope |
| wrapped_ak_rec | TEXT | envelope |
| recovery_verifier | TEXT | HMAC-SHA256 hex |
| public_key | TEXT | X25519 |
| encrypted_private_key | TEXT | envelope |
| key_generation | INTEGER | bumps on key rotation |
| security_stamp | INTEGER | bump to invalidate sessions |
| totp_secret_enc | TEXT NULL | login 2FA, server-encrypted |
| totp_last_step | INTEGER NULL | replay protection |
| settings | TEXT | JSON, non-sensitive (auto-lock minutes, theme) |
| created_at, updated_at | INTEGER | |

### `sessions`
id TEXT PK, user_id → users (cascade), token_hash TEXT UNIQUE, security_stamp INTEGER, user_agent TEXT, created_at, last_seen_at, expires_at.

### `webauthn_credentials`
id TEXT PK, user_id → users (cascade), credential_id TEXT UNIQUE, public_key TEXT, counter INTEGER, transports TEXT, name TEXT, created_at, last_used_at.

### `backup_codes`
id TEXT PK, user_id → users (cascade), code_hash TEXT, used_at INTEGER NULL.

### `email_codes`
id TEXT PK, email TEXT, purpose TEXT (`signup` | `recovery` | `reset_account` | `sensitive_action`), code_hash TEXT, attempts INTEGER, expires_at INTEGER, consumed_at INTEGER NULL.

### `auth_challenges`
id TEXT PK, user_id, kind (`2fa` | `recovery` | `webauthn_register` | `webauthn_auth`), token_hash, payload TEXT (JSON), expires_at.

### `vaults`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | client-generated |
| owner_id | TEXT → users | cascade |
| key_version | INTEGER | starts at 1 |
| encrypted_meta | TEXT | name/icon/colour under VK |
| rotation_pending | INTEGER | 0/1 |
| created_at, updated_at | INTEGER | |

### `vault_members`
id TEXT PK, vault_id → vaults (cascade), user_id → users (cascade), role TEXT, key_version INTEGER, sealed_key TEXT, status TEXT (`pending` | `active`), invited_by TEXT, created_at, updated_at. UNIQUE(vault_id, user_id). The owner also has a row (role `owner`).

### `items`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | client-generated |
| vault_id | TEXT → vaults | cascade |
| item_key_version | INTEGER | |
| wrapped_key | TEXT | IK under VK |
| vault_key_version | INTEGER | which VK wrapped it |
| encrypted_data | TEXT | item content under IK, max ~90 KB encoded |
| revision | INTEGER | optimistic concurrency |
| created_by, updated_by | TEXT | user ids |
| created_at, updated_at | INTEGER | |
| trashed_at | INTEGER NULL | soft delete, purged after 30 days |

Index: `(vault_id, updated_at)`.

### `item_shares`
id TEXT PK, item_id → items (cascade), user_id → users (cascade), role TEXT, key_version INTEGER, sealed_key TEXT, status TEXT, invited_by TEXT, created_at, updated_at. UNIQUE(item_id, user_id).

### `rate_limits`
key TEXT PK (e.g. `login:email:<hash>`, `login:ip:<ip>`), window_start INTEGER, count INTEGER.

### `audit_events`
id TEXT PK, user_id, event TEXT (`login`, `password_changed`, `recovery_used`, `share_created`, `share_revoked`, `2fa_enabled`, ...), meta TEXT (JSON, never secrets), created_at. Shown to the user under Settings → Activity; purged after 90 days.

---

## 13. HTTP API

All routes under `/api`. JSON in/out. Errors: `{ "error": { "code": "snake_case", "message": "Human text" } }`. All request bodies validated with zod schemas from `packages/shared`. Non-GET requests must carry a matching `Origin` header. Items and other blobs use base64url strings.

### Auth (no session required)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/email/start` | Send email code (`signup`, `recovery`, `reset_account`) |
| POST | `/auth/signup` | Create account (body: email code + key material + default vault) |
| POST | `/auth/prelogin` | Get salt + KDF params |
| POST | `/auth/login` | Verify authKey → session or 2FA challenge |
| POST | `/auth/2fa/verify` | Complete login with TOTP / passkey / backup code |
| POST | `/auth/webauthn/options` | Passkey assertion options for a challenge |
| POST | `/auth/recovery/start` | Verify recovery phrase → wrapped AK + recovery token |
| POST | `/auth/recovery/complete` | Set new password material |
| POST | `/auth/reset-account` | Last-resort wipe with email code |
| POST | `/auth/logout` | End current session |

### Me (session required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me` | Profile, settings, 2FA status |
| GET | `/me/keys` | Key bundle for unlock |
| POST | `/me/password` | Change password (10.4) |
| POST | `/me/password/reset-from-unlocked` | 10.5 B |
| POST | `/me/recovery` | Replace recovery kit (new wrapped AK + verifier) |
| POST | `/me/kdf-upgrade` | Re-wrap with stronger KDF params |
| GET/DELETE | `/me/sessions`, `/me/sessions/:id` | List/revoke sessions |
| POST | `/me/2fa/totp/setup`, `/me/2fa/totp/enable`, `/me/2fa/totp/disable` | Login TOTP |
| POST/DELETE | `/me/2fa/webauthn/...` | Register/remove passkeys |
| POST | `/me/2fa/backup-codes` | Regenerate backup codes |
| GET | `/me/activity` | Audit events |
| PATCH | `/me/settings` | Non-sensitive settings |
| DELETE | `/me` | Delete account (requires authKey + email code) |

### Vaults, items, shares (session required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/sync?since=<ms>` | Everything changed since a timestamp: vaults, memberships, items, item shares, deletions (tombstones). Full sync when `since` omitted |
| POST | `/vaults` | Create vault (+ owner membership) |
| PATCH | `/vaults/:id` | Update encrypted metadata |
| DELETE | `/vaults/:id` | Owner only |
| POST | `/vaults/:id/members` | Invite member |
| PATCH/DELETE | `/vaults/:id/members/:memberId` | Change role / remove |
| POST | `/vaults/:id/rotate` | Upload a chunk of rotated items / finalise rotation |
| POST | `/vaults/:id/leave` | Leave a shared vault |
| POST | `/items` | Create item |
| PUT | `/items/:id` | Update; body includes `revision`; `409 revision_conflict` if stale |
| POST | `/items/:id/trash`, `/items/:id/restore` | Soft delete / restore |
| DELETE | `/items/:id` | Permanent delete (from trash) |
| POST | `/items/:id/move` | Move to another vault (client re-wraps IK with target VK) |
| POST | `/items/:id/shares` | Share item |
| DELETE | `/items/:id/shares/:shareId` | Revoke item share |
| GET | `/shares/pending` | Invitations for me |
| POST | `/shares/:id/accept`, `/shares/:id/decline` | Respond to invite |
| GET | `/users/lookup?email=` | Public key for sharing |

Deletions need tombstones for sync: keep a small `deletions` table (`entity`, `id`, `vault_id`, `deleted_at`) purged after 90 days, or return "full resync required" if `since` is older than that.

---

## 14. Feature specs: items, password generator, TOTP

### 14.1 Item content (plaintext JSON before encryption, defined as zod schema in `packages/shared`)

```ts
type ItemContent =
  | {
      type: "login";
      name: string;
      username?: string;
      password?: string;
      urls: string[];
      totp?: string;          // full otpauth:// URI (normalised)
      notes?: string;
      customFields: { label: string; value: string; hidden: boolean }[];
      passwordUpdatedAt?: number;
    }
  | { type: "note"; name: string; notes: string };
  // Phase 7: "card", "identity"
```

Max plaintext size 64 KB. Item names, URLs and everything else are encrypted; **search runs client-side** over decrypted items in memory.

Favicons: off by default (fetching `example.com/favicon.ico` would leak which sites are in the vault to that site). Show a coloured letter avatar instead.

### 14.2 Password generator (`packages/generator`)

**Random mode**
- Length 8–128, default 20.
- Character sets: lowercase, uppercase, digits, symbols (`!@#$%^&*()-_=+[]{};:,.?/`); default all on.
- Option "avoid ambiguous characters" (`0 O o 1 l I |`).
- Guarantee at least one character from each selected set: pick one from each set, fill the rest from the union, then Fisher–Yates shuffle.
- **Unbiased randomness:** `crypto.getRandomValues` with rejection sampling (never `% n` on raw bytes, never `Math.random`).

**Passphrase mode**
- EFF large wordlist (7,776 words, ~12.9 bits/word), bundled.
- 3–12 words, default 5; separator (`-`, space, `.`, `_`, digit); capitalise option; "include a number" option.

**Output**
- Entropy in bits computed from the generator settings (exact, e.g. 20 chars from 90 symbols ≈ 129 bits; 5 words ≈ 64.6 bits) shown as a meter: < 50 weak, 50–79 fair, 80–99 strong, ≥ 100 very strong.
- For passwords the user types in, use zxcvbn-ts instead.
- Settings remembered per user (stored in encrypted user settings, or local non-sensitive preferences).
- Available as a standalone page and inline in the item editor ("Generate" button next to the password field).

### 14.3 TOTP (`packages/otp` + UI widget)

**Input**
- Paste an `otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30` URI.
- Paste a bare Base32 secret (assume SHA1, 6 digits, 30 s; let the user change them).
- Scan a QR code: from camera (`BarcodeDetector` API where available, `jsqr` fallback), from an uploaded image, or from a pasted screenshot.
- Validate: Base32 decodes, digits ∈ {6, 7, 8}, period ∈ 1..300, algorithm ∈ {SHA1, SHA256, SHA512}. Store the normalised URI.
- HOTP (counter-based) is out of scope for MVP; show "unsupported" if seen.

**Display (the live timer)**
- Code shown in groups (`123 456`), click to copy.
- Circular progress ring + seconds remaining: `remaining = period - (floor(now/1000) mod period)`.
- Re-render with `requestAnimationFrame` (or a 250 ms interval) so the ring is smooth; recompute the code when the time step `floor(now/1000/period)` changes.
- Last 5 seconds: ring turns amber and the **next code** is shown underneath, so users don't type a code about to expire.
- Pause timers when the tab is hidden (`visibilitychange`) and resync on return.
- **Clock skew correction:** compute `serverOffset` from the `Date` header of API responses (median of the last few) and use `Date.now() + serverOffset` when the device clock is off by more than 10 s. Show a small warning if the skew is large.
- Item list shows the current code + mini ring for items that have TOTP, so the vault doubles as an authenticator app.

**Correctness:** unit tests use the RFC 6238 Appendix B test vectors (SHA1/SHA256/SHA512, 8 digits) and RFC 4226 HOTP vectors.

### 14.4 Other client features

- **Copy to clipboard** with auto-clear after 30 s (best effort: only clears if the clipboard still holds our value and the page has focus).
- **Reveal password** toggle; hidden by default.
- **Trash:** 30-day retention, restore, empty trash. Purged by the daily cron.
- **Import/export (Phase 6):** import CSV from Bitwarden, Chrome, Proton Pass and 1Password; export as an encrypted JSON (password-protected with Argon2id) or plain CSV with a strong warning.

---

## 15. Frontend architecture

- **Crypto worker:** a dedicated Web Worker owns libsodium and all keys. The UI talks to it with typed messages via a tiny RPC wrapper (`comlink`-style, hand-written to avoid a dependency). Locking = telling the worker to wipe its key store.
- **State:** TanStack Query for server data (ciphertext), a decrypted in-memory store (inside the worker; UI receives decrypted item objects on demand) for vault contents.
- **Sync:** full sync on unlock; incremental `GET /sync?since=` on window focus and every 60 s while unlocked; after writes, update local state optimistically.
- **Routing:** `/login`, `/signup`, `/recover`, `/unlock`, `/vault/:vaultId?`, `/item/:itemId`, `/generator`, `/shared`, `/settings/*`.
- **Responsive:** sidebar (vaults) + list + detail on desktop; stacked on mobile.
- **Accessibility:** keyboard navigation, focus management in dialogs, `aria-live` for the TOTP countdown at a low rate (announce only on code change).
- **No secrets in URLs, logs, `localStorage` or error reports.** Only non-sensitive UI preferences may be stored locally.

---

## 16. Build phases

Each phase ends with passing CI and a deployable app. Tick boxes as work lands (in the same commit).

### Phase 0: Scaffolding
- [ ] Bun workspace root (`package.json` workspaces: `apps/*`, `packages/*`), `tsconfig.base.json` (strict), Biome config
- [ ] `apps/api`: Hono app with `GET /api/health`, `wrangler.jsonc` (D1 binding `DB`, assets from `../web/dist`, `run_worker_first: ["/api/*"]`, SPA fallback `not_found_handling: "single-page-application"`, cron trigger), security headers middleware
- [ ] `apps/web`: Vite + React + Tailwind + TanStack Router/Query, calls `/api/health`
- [ ] `packages/shared`, `packages/crypto`, `packages/generator`, `packages/otp` with empty exports and a test each
- [ ] Drizzle config for D1, first empty migration, local D1 via `wrangler dev`
- [ ] Root scripts: `dev`, `build`, `test`, `lint`, `typecheck`, `db:generate`, `db:migrate:local`, `db:migrate:remote`, `deploy`
- [ ] `.gitignore` (`node_modules`, `dist`, `.wrangler`, `.dev.vars`, `*.sqlite`, backups), `.dev.vars.example`
- [ ] `ci.yml`: install, lint, typecheck, test, build
- [ ] README quickstart
- [ ] First deploy to `*.workers.dev` (owner runs `wrangler login` and creates the D1 database)

### Phase 1: Core libraries (no UI, fully tested)
- [ ] `packages/crypto`: sodium init, Argon2id derive, subkeys, envelope encrypt/decrypt with AAD, sealed boxes, recovery phrase (BIP39) generate/parse, key bundle builders for signup/password change/recovery, fixed test vectors
- [ ] `packages/generator`: unbiased random index, random mode, passphrase mode (EFF list), entropy calculation, property tests (distribution, set guarantees)
- [ ] `packages/otp`: URI parse/normalise/validate, Base32, code generation, `remaining()`/`progress()`, RFC 6238/4226 vectors
- [ ] `packages/shared`: zod schemas for item content and all API request/response bodies

### Phase 2: Accounts
- [ ] D1 schema: users, sessions, email_codes, auth_challenges, rate_limits, audit_events
- [ ] Email sending (Resend) with a dev mode that logs codes to the console
- [ ] Signup flow incl. email code and recovery kit screen (10.1)
- [ ] Prelogin with fake salts, login, sessions, logout (10.2)
- [ ] Crypto worker + lock/unlock + auto-lock (10.3)
- [ ] Change master password (10.4)
- [ ] Rate limiting (D1-backed fixed windows: login 10/15 min per email, 30/15 min per IP; email codes 5/hour per email)
- [ ] Origin check middleware, session middleware with `security_stamp`
- [ ] Signup gating by `SIGNUP_MODE` (see [Open questions](#20-open-questions-for-the-owner))

### Phase 3: Personal vault
- [ ] D1 schema: vaults, vault_members, items, deletions
- [ ] Default vault created at signup; create/rename/delete extra vaults
- [ ] Item CRUD (login, note) with revision conflicts, trash/restore/purge
- [ ] `/sync` full + incremental
- [ ] UI: sidebar, item list with client-side search, item detail, item editor
- [ ] Inline + standalone password generator UI
- [ ] TOTP: add via URI/secret/QR (camera, upload, paste), live code + countdown ring, next-code preview, clock skew correction, codes in the list view
- [ ] Copy with clipboard auto-clear, reveal toggles
- [ ] Daily cron: purge trash > 30 days, expired sessions/codes/challenges, old audit events and tombstones

### Phase 4: Sharing
- [ ] `/users/lookup`, invitations, accept/decline
- [ ] Vault sharing with roles, server-side role enforcement
- [ ] Single-item sharing
- [ ] Revocation with key rotation (vault and item), `rotation_pending` recovery
- [ ] Move item between vaults
- [ ] "Shared with me" view, member management UI, leave vault

### Phase 5: Account security and recovery
- [ ] Login TOTP (setup, enable, disable, replay protection)
- [ ] Passkeys as second factor (confirm `@simplewebauthn/server` works on Workers; otherwise implement verification with WebCrypto)
- [ ] Backup codes
- [ ] Recovery kit redemption (10.5 A) and regeneration
- [ ] Reset from an unlocked device (10.5 B)
- [ ] Reset account (10.5 D)
- [ ] Sessions list/revoke UI, activity log UI
- [ ] Delete account

### Phase 6: Production hardening
- [ ] `backup.yml`: daily `wrangler d1 export --remote` → `age` encrypt → R2, 30-day lifecycle rule; documented restore drill (`scripts/restore.md`) and one test restore into a scratch D1
- [ ] `deploy.yml`: on push to `master`, run CI, apply D1 migrations, `wrangler deploy`
- [ ] CSP and headers verified on both assets and API; `securityheaders.com`-style check
- [ ] Playwright E2E for signup → add item with TOTP → share → recipient sees it → revoke → change password → recover with kit
- [ ] Import (CSV formats) and export (encrypted JSON, CSV)
- [ ] Quota-exceeded handling and friendly error pages
- [ ] Dependency audit; pin versions; enable Dependabot/Renovate
- [ ] Threat model review against [section 8](#8-security-model)

### Phase 7: Later
- [ ] Password health (weak, reused, old), HIBP k-anonymity breach check (opt-in)
- [ ] Unlock with passkey (WebAuthn PRF)
- [ ] Emergency access (10.5 C)
- [ ] Public key fingerprints for share verification
- [ ] PWA with offline read-only cache of ciphertext
- [ ] Browser extension (autofill), reusing `packages/*`
- [ ] Card and identity item types; Google Authenticator migration import
- [ ] Optional favicons via a privacy-preserving proxy

---

## 17. Testing strategy

| Layer | Tool | What |
|-------|------|------|
| `packages/crypto` | Vitest | Round-trips, AAD mismatch fails, wrong key fails, fixed vectors (format stability), recovery phrase checksum, full signup → password change → recovery simulation without a server |
| `packages/generator` | Vitest | Length/sets honoured, at-least-one-per-set, no ambiguous chars when excluded, chi-square-style distribution sanity check, entropy maths |
| `packages/otp` | Vitest | RFC 6238 + RFC 4226 vectors, URI parsing edge cases, countdown maths at period boundaries |
| `apps/api` | Vitest + `@cloudflare/vitest-pool-workers` (real workerd + local D1) | Every route: auth, role enforcement (viewer can't write, removed member gets 403), revision conflicts, rate limits, session invalidation via `security_stamp`, fake-salt prelogin |
| `apps/web` | Vitest + Testing Library | Generator UI, TOTP widget timing (fake timers), lock/unlock |
| End to end | Playwright | The Phase 6 journey across two browser contexts (two users) |

CI must pass before merge/deploy. Crypto code changes require new or updated tests in the same commit.

---

## 18. Deployment, operations and backups

### One-time owner setup (Cloudflare free account)
1. Create a Cloudflare account; install deps with `bun install`; run `bunx wrangler login`.
2. `bunx wrangler d1 create password-manager` → put the `database_id` in `apps/api/wrangler.jsonc`.
3. `bunx wrangler r2 bucket create pm-backups` and add a lifecycle rule deleting objects older than 30 days.
4. Set secrets (see [section 19](#19-configuration-reference)) with `bunx wrangler secret put NAME`.
5. Create a Resend account and API key; verify a sending domain, or use Resend's test sender during development.
6. For GitHub Actions: repository secrets `CLOUDFLARE_API_TOKEN` (scoped to Workers, D1, R2 edit), `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_AGE_PUBLIC_KEY`. Keep the matching `age` private key **offline** (password manager of the owner + printed copy).

### Deploy
- `bun run deploy` = build web → apply remote D1 migrations → `wrangler deploy`.
- Automated by `deploy.yml` on push to `master` after CI passes.
- Migrations must be backward compatible with the currently deployed code (add columns before using them; drop in a later release).

### Backups and restore
- Daily (`backup.yml`, cron `17 3 * * *`): `wrangler d1 export password-manager --remote --output=dump.sql` → `age -r $BACKUP_AGE_PUBLIC_KEY` → `wrangler r2 object put pm-backups/YYYY-MM-DD.sql.age`.
- Fast restore for the last 7 days: D1 Time Travel (`wrangler d1 time-travel restore`).
- Older: download from R2, decrypt with the offline `age` key, `wrangler d1 execute <db> --remote --file=dump.sql` into a fresh database, switch the binding.
- Practise a restore once per quarter.

### Monitoring
- Workers dashboard analytics (free) for errors and request counts.
- `wrangler tail` for live logs. Logs must never contain request bodies, keys, verifiers or codes.
- Optional: a daily GitHub Action that calls `/api/health` and opens an issue on failure.

---

## 19. Configuration reference

### Worker bindings (`wrangler.jsonc`)
| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Main database |
| `ASSETS` | Static assets | SPA build |

### Worker vars (non-secret, in `wrangler.jsonc`)
| Name | Example | Purpose |
|------|---------|---------|
| `APP_ORIGIN` | `https://pm.example.workers.dev` | Origin check, links in emails, WebAuthn RP ID |
| `ENVIRONMENT` | `production` / `development` | Dev mode logs email codes instead of sending |
| `SIGNUP_MODE` | `invite` | `open`, `allowlist`, or `invite` |
| `SIGNUP_ALLOWLIST` | `a@x.com,b@y.com` | Used when `SIGNUP_MODE=allowlist` |
| `KDF_DEFAULT_MEM` | `67108864` | 64 MiB |
| `KDF_DEFAULT_OPS` | `3` | |
| `EMAIL_FROM` | `Password Manager <no-reply@example.com>` | |

### Worker secrets (`wrangler secret put`, locally in `apps/api/.dev.vars`)
| Name | Purpose | How to generate |
|------|---------|-----------------|
| `AUTH_PEPPER` | HMAC key for `auth_verifier` and `recovery_verifier` | 32 random bytes, base64url |
| `FAKE_SALT_KEY` | Deterministic fake salts for unknown emails | 32 random bytes |
| `SERVER_ENC_KEY` | AES-256-GCM key for login TOTP secrets | 32 random bytes |
| `RESEND_API_KEY` | Email sending | Resend dashboard |

**Never rotate `AUTH_PEPPER` casually:** every user's verifier depends on it. Rotation would need a dual-pepper migration (verify with old, rewrite with new on next login).

Generate a secret: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

---

## 20. Open questions for the owner

1. **Who can sign up?** Recommendation: `invite` or `allowlist` mode. Open signup on a free plan invites abuse and exhausts email/D1 quotas. In `invite` mode an existing user generates single-use invite links.
2. **App name and domain.** Is `*.workers.dev` acceptable, or will you buy a domain? (A domain is the only thing that would cost money; it also makes email deliverability much better.)
3. **Email provider.** Resend free tier is the default. Confirm, or pick an alternative.
4. **Expected number of users.** Sizing assumes up to ~100 users / ~50k items, far inside the free limits.
5. **Repository visibility.** Public repos get unlimited GitHub Actions minutes; private repos get 2,000/month (enough). Public code is fine security-wise for an E2E design, but it's your call.

Until answered, build with `SIGNUP_MODE=allowlist` and a `workers.dev` domain.

---

## 21. Conventions for contributors and AI sessions

**Start here:** read this whole file, then `README.md`, then check which Phase in [section 16](#16-build-phases) has unticked boxes. Work on the earliest unfinished phase unless the owner says otherwise.

Hard rules:
1. **The server never receives plaintext secrets or keys.** If a feature seems to need that, stop and redesign or ask the owner.
2. **All crypto lives in `packages/crypto`.** No libsodium/WebCrypto encryption calls elsewhere (the server's HMAC/AES helpers in `apps/api/src/lib` are the only exception, and they never touch vault data).
3. **Never change an existing ciphertext format, AAD string or KDF context in place.** Add a new version and keep decoding the old one. Update test vectors.
4. **No server-side password hashing** (10 ms CPU limit). Server does HMAC/SHA-256 only.
5. **Never query D1 in a loop.** Use `batch()`. Multi-row writes that must be atomic go in one `batch()`.
6. **Web-standard APIs only** in `apps/api` and `packages/*` (no `Bun.*`, no Node-only modules).
7. **Never log or persist** request bodies, keys, verifiers, email codes, TOTP secrets or decrypted data. No secrets in URLs.
8. **Never commit** `.dev.vars`, `.env`, database files, backups, or real user data.
9. **No new runtime dependency in `apps/web` or `packages/*` without a one-line justification** in the commit message. Prefer the platform.
10. **Schema changes only via drizzle-kit migrations** (`bun run db:generate`), never by editing applied migrations.
11. **Update this file in the same commit** as the work: tick checkboxes, record new decisions in [section 3](#3-key-decisions-and-their-rationale), add limits/config to sections 4 and 19.
12. Lint, typecheck and tests must pass before pushing.

Code style: TypeScript strict, Biome defaults, small modules, named exports, zod at every trust boundary (API input, decrypted item content, sealed key payloads).

---

## 22. Glossary

| Term | Meaning |
|------|---------|
| **E2E / zero-knowledge** | Data is encrypted and decrypted only on the user's device; the server can't read it |
| **Master password** | The password the user types; never sent to or stored on the server |
| **passwordKey** | Argon2id output from master password + salt |
| **authKey** | Subkey of passwordKey sent to the server to prove the password at login |
| **wrapKey** | Subkey of passwordKey used to encrypt the account key |
| **AK (account key)** | Random key created at signup that protects the user's private key; wrapped by wrapKey and by the recovery key |
| **Identity keypair** | Per-user X25519 keypair; the public key lets others share keys with this user |
| **VK (vault key)** | Random key per vault (versioned); encrypts vault metadata and item keys |
| **IK (item key)** | Random key per item (versioned); encrypts the item's content |
| **Sealed box** | libsodium public-key encryption to a recipient's public key (anonymous sender) |
| **AAD** | Associated data: authenticated but not encrypted context that binds a ciphertext to its record |
| **Pepper** | Server-side secret key (Worker secret, not in the DB) used in HMAC verifiers |
| **Recovery kit** | 24-word phrase that can unlock AK if the master password is forgotten |
| **TOTP** | Time-based one-time password (RFC 6238), the 6-digit codes authenticator apps show |
| **security_stamp** | Per-user counter; bumping it invalidates all existing sessions |
| **D1** | Cloudflare's serverless SQLite database |
| **Time Travel** | D1's point-in-time restore (7 days on the free plan) |

# Password Manager: Project Plan

This document is the single source of truth for the project. It is written so that someone (a person or a new AI session) with **no prior context** can read it top to bottom and start working. If you change a decision, update this file in the same commit.

**Status:** Phases 0–5 implemented and tested (all routes in section 13). Web app for Phases 2–5 done. Remaining: Phase 6 (E2E tests, import/export, hardening) and the first deploy. First deploy waits on owner setup (section 18) (see [Build phases](#16-build-phases)).

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
10. [Account flows: invites, login, unlock, password change, recovery](#10-account-flows-invites-login-unlock-password-change-recovery)
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
| 1 | **Accounts (invite-only)** | No public signup. A super admin invites people by email; the invitee opens the link, sets their master password and is logged in. Each user has their own encrypted vault(s). |
| 2 | **Secure storage** | Logins (username, password, URLs, notes, custom fields), secure notes. Everything is encrypted in the browser before it reaches the server. |
| 3 | **Strong password generator** | Random-character passwords and word-based passphrases, generated with a cryptographically secure RNG, with a strength/entropy readout. |
| 4 | **TOTP authenticator** | Store 2FA secrets (from `otpauth://` URIs or QR codes) inside items. Show the current code with a **live countdown** that regenerates at the end of each period (30 s, 60 s, or whatever the site uses). |
| 5 | **Sharing** | Share a whole vault or a single item with other registered users, with roles (viewer, editor, manager). Revoke access at any time. |
| 6 | **Account security** | Login 2FA for the app itself (TOTP and passkeys/WebAuthn), backup codes, session management, auto-lock. |
| 8 | **Admin** | Super admin manages invites (send, resend, revoke) and users (disable, enable, delete, reset). Admins can never read anyone's vault. |
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
| Domain | **`password-manager.azzaz.dev`** as a Workers Custom Domain; API at `/api/*` on the same host | Owner's zone `azzaz.dev` is on Cloudflare (apex = personal portfolio). Free Universal SSL covers the apex and **one** subdomain level only, so the app must be a first-level subdomain (never e.g. `api.password-manager.azzaz.dev`). A path prefix avoids a second subdomain, CORS and cross-origin cookies | Separate `api.` subdomain (two origins, CORS, cookie scoping) |
| Registration | **Invite-only.** A super admin is bootstrapped via an emailed setup link to `ADMIN_EMAIL`; the admin invites users by email | Small private user group; protects free quotas; no shared "known" credentials (see 10.0) | Open signup; seeded admin with a known password (server can't create E2E keys, and a known password stays usable against old backups forever) |
| Production runtime | Cloudflare `workerd` (not Bun) | That's what the free plan runs. Bun is used for local tooling only | Bun on Fly.io (costs money) |
| Database | **Cloudflare D1** (SQLite) | Free, same account, no cold starts, no connection pooling, 7-day point-in-time restore. Encrypted blobs need nothing Postgres-specific | Supabase free (pauses after ~7 days idle and stays offline until manually restored); Neon free (works, but a second vendor and cold starts) |
| ORM / query builder | **Drizzle** + drizzle-kit migrations | First-class D1 support, light, fast startup, typed | Prisma (heavier; D1 support via adapter) |
| Crypto library | **libsodium** (`libsodium-wrappers-sumo`, the "sumo" build is needed for Argon2id) | Audited, one library for KDF, AEAD, key exchange; WASM | Hand-rolled WebCrypto for everything (no Argon2 in WebCrypto) |
| Password KDF | **Argon2id**, 64 MiB, 3 iterations, run in the browser | Memory-hard; the slow part runs on the client so the server stays within the 10 ms CPU limit | PBKDF2 (weaker against GPUs); server-side Argon2/bcrypt (exceeds the free 10 ms CPU limit) |
| Server-side verifier | `HMAC-SHA256(pepper, authKey)` | The input is a 256-bit derived key, not a human password, so a fast keyed hash is safe and fits 10 ms CPU | Argon2/bcrypt on the server |
| TOTP | `otpauth` library, computed in the browser | Supports SHA1/256/512, 6–8 digits, any period; secrets never leave the client unencrypted | Server-side TOTP generation (server would need secrets) |
| Recovery phrase encoding | BIP39 24 words via `@scure/bip39` | Well-known, has a checksum, audited, tiny | Custom word encoding |
| Frontend | React + Vite SPA, TanStack Query, TanStack Router, Tailwind CSS | Common, well-documented, fast builds | Next.js / SSR (unnecessary; server can't render decrypted data anyway) |
| Email sending | **Resend HTTP API** (`POST https://api.resend.com/emails` with `fetch`), free tier | Needed for invites and recovery codes; free tier covers a small user base. One `fetch` from the Worker, no extra dependency | Resend SMTP (Workers have no built-in SMTP client); self-hosted SMTP |
| CI/CD | **GitHub Actions** (private repo) running **Wrangler** with a scoped Cloudflare API token; deploy on push to `master` | Standard, free within 2,000 min/month, no local credentials needed by contributors or AI sessions | Manual `wrangler deploy` from a laptop |
| Backups | GitHub Actions scheduled job: `wrangler d1 export` → encrypt with `age` → upload to **R2** | Free (Actions + R2 free tier); off-platform copy beyond D1's 7-day restore window | Upstash QStash (would still need somewhere to run `pg_dump`/export) |
| Scheduled jobs | Workers **Cron Triggers** in the same Worker | Free; used for purging trash, expired sessions and codes | External cron services |
| Lint/format | **Biome** | One fast tool for both | ESLint + Prettier |
| Tests | **Vitest** (+ `@cloudflare/vitest-plugin` for the API), **Playwright** for E2E | Vitest is what Cloudflare's Workers test plugin uses (`@cloudflare/vitest-plugin`, the renamed successor of `vitest-pool-workers`); one test runner everywhere | `bun test` (doesn't run inside workerd) |

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
| GitHub Actions | Repo is **private**: 2,000 min/month | CI + deploy + daily backup ≈ a few hundred minutes/month. Cache Bun installs; skip E2E on docs-only changes |
| Resend | ~3,000 emails/month, 100/day, 1 sending domain | Emails only for invites, recovery codes and security notices |
| Domain | Owner already owns `azzaz.dev` (on Cloudflare) | `password-manager.azzaz.dev` Custom Domain and its certificate are free |

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
| Tests | `vitest`, `@cloudflare/vitest-plugin`, `@playwright/test` |

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
| CSRF | `SameSite=Strict` cookie, same origin, and an **exact** `Origin` header check (`=== APP_ORIGIN`) on all non-GET requests. The exact check matters: sibling subdomains such as the portfolio at `azzaz.dev` count as "same-site", so `SameSite` alone doesn't stop them |
| Sibling subdomains on `azzaz.dev` | `__Host-` cookie (bound to the exact host, can't be set or read by `azzaz.dev`); WebAuthn RP ID is `password-manager.azzaz.dev`, not `azzaz.dev` |
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

Passwords are normalised with Unicode **NFKC** before Argon2id, so the same password typed on different systems derives the same key (this can never change without breaking accounts). The client refuses KDF parameters outside mem 16 MiB–1 GiB / ops 2–16, so a malicious server can neither downgrade the KDF nor make the client hang. On unlock the client checks that the public key in the key bundle matches the decrypted private key.

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
                                ACCOUNT KEY  AK (32 B random, created once at account creation, never changes
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

## 10. Account flows: invites, login, unlock, password change, recovery

There is **no public signup**. Every account is created by accepting an invite. User roles: `admin` (can manage invites and users) and `user`.

### 10.0 Bootstrapping the super admin

Why not a seeded admin with known credentials: in an E2E design the server can't create an account at all (the key material is derived from the master password in a browser), and a password that is "known" (in chat, the repo, env files or CI logs) protects the admin's vault only as well as that leak allows. Changing it later doesn't fully help: a password change re-wraps AK, but any backup taken before the change still holds AK wrapped under the old password, so the old password unlocks that backup forever.

Instead:
1. The Worker var `ADMIN_EMAIL` names the owner's email (configured, not secret).
2. `GET /api/setup/status` returns `{needsSetup: true}` while no user with role `admin` exists.
3. The SPA shows `/setup` with one button: "Email me the setup link". `POST /api/setup/start` (no body) creates an invite with role `admin` for `ADMIN_EMAIL` and emails it. Rate-limited (3/hour). Once an admin exists both endpoints return `404`.
4. The owner accepts it like any invite (10.1) and chooses their own master password. Nobody else ever knows it.

In local development, email sending is replaced by logging the link to the console, so bootstrapping takes seconds.

### 10.1 Invites and account creation

**Admin sends an invite**
1. Admin (logged in, unlocked) enters an email. `POST /api/admin/invites {email}`.
2. Server rejects if the email already has an account or a live invite (`409`), otherwise creates an `invites` row: random 32-byte token (DB stores only `SHA-256(token)`), role `user`, expiry 72 h (`INVITE_TTL_HOURS`).
3. Server sends the email via Resend: "<admin email> invited you to Password Manager", link `https://password-manager.azzaz.dev/invite#t=<token>`. The token is in the **URL fragment**, which browsers never send to the server, so it can't end up in logs or `Referer` headers.
4. Admin can list, resend (issues a new token, invalidates the old one) and revoke invites.

**Invitee accepts**
1. The SPA reads the token from the fragment, then removes it from the address bar (`history.replaceState`).
2. `POST /api/invites/inspect {token}` → `{email, invitedBy, expiresAt}` or `410 invite_invalid` (expired, used, revoked: same error for all).
3. The page shows the email (read-only) and asks for a master password (minimum 12 characters, zxcvbn score ≥ 3, with a clear explanation that nobody, including the admin, can reset it without the recovery kit) and confirmation.
4. In the crypto worker the client:
   1. generates `userId`, `salt`, derives `passwordKey` → `authKey`, `wrapKey`;
   2. generates `AK`, identity keypair; encrypts private key with AK; wraps AK with wrapKey;
   3. generates the recovery phrase (32 random bytes → 24 BIP39 words), derives `recoveryAuthKey`, `recoveryWrapKey`; wraps AK with recoveryWrapKey;
   4. creates the default vault "Personal": `vaultId`, `VK`, encrypted metadata, VK sealed to the user's own public key.
5. `POST /api/auth/accept-invite {token, ...all of the above}`. The server re-checks the token, stores HMACs of `authKey` and `recoveryAuthKey`, and in one `batch()` creates the user (role from the invite, `email_verified_at = now` because opening the emailed link proves inbox access), the vault and owner membership, and marks the invite accepted. It starts a session.
6. **Recovery kit screen** (cannot be skipped): show the 24 words, offer "Download recovery kit" (a text file with the words, email and instructions), and ask the user to type 3 randomly chosen words to confirm they saved it.

### 10.1a What admins can and cannot do

| Can | Cannot |
|-----|--------|
| Send, resend, revoke invites | Read any vault, item or vault name |
| List users (email, role, status, created, last login, 2FA on/off) | Reset someone's password **and keep their data** |
| Disable / enable a user (disabled: login refused, all sessions revoked) | See passwords, TOTP secrets or recovery phrases |
| Delete a user (their owned vaults and items are deleted) | Bypass the user's 2FA to sign in as them |
| Reset a user's account (10.5 D on their behalf: data wiped, user gets a fresh invite to set a new password) | |
| Promote/demote admins (can't demote the last admin) | |

### 10.2 Login

1. `POST /api/auth/prelogin {email}` → `{kdf: {alg, mem, ops}, salt}`. Unknown emails get `salt = HMAC(FAKE_SALT_KEY, email)[0..16]` and default params, so responses look the same.
2. Client derives `passwordKey` → `authKey` (Argon2id takes ~0.5–1.5 s; show a spinner, it runs in the worker).
3. `POST /api/auth/login {email, authKey}`. Server computes `HMAC(AUTH_PEPPER, authKey)` and compares in constant time.
   - Wrong: `401 invalid_credentials` (same message for unknown email), count towards rate limit.
   - Right, 2FA off: create session, return the key bundle (see unlock).
   - Right, 2FA on: return `{twoFactorRequired: true, methods: [...], challengeToken}` (random, 5 min, stored hashed). Then `POST /api/auth/2fa/verify {challengeToken, totp | webauthnAssertion | backupCode}` creates the session.
4. Client unwraps AK with `wrapKey`, decrypts the private key, then syncs vaults.

**Sessions:** cookie `__Host-pm_session` (HttpOnly, Secure, SameSite=Strict, Path=/), value = 32 random bytes base64url. DB stores only `SHA-256(token)`. Idle expiry 30 days, absolute 90 days. Each user has a `security_stamp`; sessions created before the current stamp are invalid. Bumping the stamp logs out everywhere. In `development`/`test` (plain http) the cookie is named `pm_session` without `Secure`, because the `__Host-` prefix requires `Secure`; production always uses `__Host-pm_session`.

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
Started by the user (email code) or by an admin on their behalf (the user then receives an invite-style email to set a new password). Confirm a clear warning ("All your items will be permanently deleted. Items others shared with you will need to be re-shared.") → new keys and a new empty vault are generated, all owned vaults/items are deleted, memberships in others' vaults are removed, 2FA and passkeys are cleared, sessions are revoked.

### 10.6 Login 2FA (for the app itself)

This protects **sign-in**, not encryption. Losing it never risks data.

- **TOTP:** server generates the secret, shows QR, user confirms a code. Secret stored encrypted with `SERVER_ENC_KEY` (AES-256-GCM via WebCrypto). Accept ±1 step; store the last accepted step to block replay.
- **Passkeys (WebAuthn):** register/remove multiple; used as a second factor (and later for unlock via PRF).
- **Backup codes:** 10 single-use codes, shown once, stored as `SHA-256(code)`.

### 10.7 Key rotation (explicit, rare)

"Rotate my keys" in settings (for a suspected compromise): new AK and identity keypair, re-seal every VK/IK the user holds, re-wrap with password and recovery keys (requires the recovery phrase to be regenerated). Done client-side, uploaded in batched requests, finalised in one `batch()`.

---

## 11. Sharing

Only registered users (every account has a verified email, because accounts are created from emailed invites) can share or receive shares.

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
| email_verified_at | INTEGER | set when the invite is accepted |
| role | TEXT | `admin` or `user` |
| status | TEXT | `active` or `disabled` |
| invited_by | TEXT NULL | user id of the admin (NULL for the bootstrap admin) |
| last_login_at | INTEGER NULL | |
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

### `invites`
id TEXT PK, email TEXT, role TEXT (`admin` | `user`), token_hash TEXT UNIQUE, invited_by TEXT NULL → users, kind TEXT (`new_account` | `account_reset`), expires_at INTEGER, accepted_at INTEGER NULL, revoked_at INTEGER NULL, created_at INTEGER. At most one live invite per email (enforced in code: revoke the old one when resending).

### `email_codes`
id TEXT PK, email TEXT, purpose TEXT (`recovery` | `reset_account` | `sensitive_action`), code_hash TEXT, attempts INTEGER, expires_at INTEGER, consumed_at INTEGER NULL.

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

**The authoritative contract is the zod schemas in `packages/shared/src`** (plus `apiPaths` in `paths.ts`). This section is the overview; when they disagree, the schemas win and this section gets fixed. Decisions made while writing the schemas: 2FA verify bodies are discriminated on `method`; `recovery/complete`, `accept-invite` and `reset-account` start a session; account reset creates a **new user id** (AAD embeds the user id), so the server deletes the old user row and inserts a new one; vault rotation is one endpoint with `step: "chunk" | "finalize"`; member invites, item shares and vault metadata updates carry the `keyVersion` they were made with and the server rejects stale ones; `PUT /items/:id` accepts optional re-sealed `shareKeys` for item-key rotation; extra endpoints `POST /me/email-code` (sensitive-action codes) and `GET /me/2fa/webauthn` (list passkeys).

All routes under `/api`. JSON in/out. Errors: `{ "error": { "code": "snake_case", "message": "Human text" } }`. All request bodies validated with zod schemas from `packages/shared`. Non-GET requests must carry a matching `Origin` header. Items and other blobs use base64url strings.

### Auth (no session required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/setup/status` | `{needsSetup}` while no admin exists |
| POST | `/setup/start` | Email the admin setup invite to `ADMIN_EMAIL` (only while no admin exists) |
| POST | `/invites/inspect` | Validate an invite token → email, inviter, expiry |
| POST | `/auth/accept-invite` | Create account (body: invite token + key material + default vault) |
| POST | `/auth/email/start` | Send email code (`recovery`, `reset_account`) |
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

### Admin (session required, role `admin`)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/invites` | List invites (pending, accepted, expired, revoked) |
| POST | `/admin/invites` | Invite an email |
| POST | `/admin/invites/:id/resend` | New token + email, old token invalidated |
| POST | `/admin/invites/:id/revoke` | Revoke |
| GET | `/admin/users` | List users (metadata only) |
| PATCH | `/admin/users/:id` | Change role / status (`disabled` revokes sessions) |
| POST | `/admin/users/:id/reset` | Wipe account data and send an `account_reset` invite |
| DELETE | `/admin/users/:id` | Delete user and their owned data |

### Server behaviour decisions (made while implementing the routes)

**Accounts**
- Pending TOTP setup lives AES-GCM-encrypted in an `auth_challenges` row (kind `2fa`, purpose `totp_setup`, 15 min); `users.totp_secret_enc` is set only after the first code is confirmed, so non-null means "enabled". Disabling TOTP requires a current TOTP code or a backup code.
- Login, 2FA, password checks and TOTP enable count only **failures** against rate limits. `auth/email/start` always writes a code row (equal timing) and only mails active users.
- `recovery/start` checks the email code without consuming it (the request is retried after `two_factor_required`); it is consumed when the recovery token is issued. Passkey-only users recover with a backup code, or use reset-account.
- Admin reset deletes the user and their data immediately, writes tombstones and sends an `account_reset` invite carrying the same role. Admins can't reset/delete themselves via admin routes; demoting/disabling the last active admin is `409 last_admin` (checked inside the UPDATE, race-free).
- Creates (`accept-invite`, `reset-account`, vaults, items, shares) return `201`.

**Vaults and sharing**
- Non-members and pending members get `404` on everything in a vault; members with too low a role get `403`.
- Managers invite/manage viewers and editors only; only the owner adds/removes managers; the owner can't be removed and must delete the vault instead of leaving. No ownership transfer yet.
- Item shares are created/revoked by vault managers+ (a recipient may remove their own share). Item-share editors resend `wrappedKey`/`vaultKeyVersion`/`itemKeyVersion` unchanged and can't trash/delete/move.
- Removing any member (even a pending one) sets `rotation_pending`. While pending, item create/update/move, metadata edits, invites and new shares are `409 rotation_pending`; trash/restore/delete, removals, role changes, leave, accept/decline still work.
- Rotation chunks are staged in `vault_rotation_items` (idempotent upserts). `finalize` checks that every item (incl. trashed), member and item share is covered at `key_version + 1` with unchanged revisions, then swaps everything in one guarded `batch()`; a concurrent edit or new member aborts it. D1 allows 100 bound parameters per statement, so sealed-key updates go 25 per statement.
- Pending invitations whose inviter's account is gone are not listed (nobody vouches for them).

**Sync and tombstones**
- `deletions(entity, entity_id, vault_id, user_id, deleted_at)`. A client receives tombstones where `user_id = me`, or `user_id IS NULL` and `vault_id` is one of its current vaults. Removed members get a `vault` tombstone; remaining members get a `vault_member` tombstone; share recipients get `item_share` tombstones; moved items leave an `item` tombstone in the old vault.
- `serverTime` is the request start time; incremental sync re-reads a 2-second overlap (`updated_at > since − 2000`), so clients must apply rows idempotently and apply deletions before upserts. A vault is re-sent in full when my membership changes. `since` older than 90 days → full sync.
- Drizzle's D1 batch mode collapses selected columns with the same SQL name (e.g. two `id`s): alias duplicates in batched selects (see `apps/api/src/lib/vaults/db.ts`).

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
- Entropy in bits computed from the generator settings (exact, e.g. 20 chars from the full 86-character pool ≈ 128.5 bits; 5 words ≈ 64.6 bits) shown as a meter: < 50 weak, 50–79 fair, 80–99 strong, ≥ 100 very strong.
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
- **Routing:** `/setup`, `/invite`, `/login`, `/recover`, `/unlock`, `/admin/*`, `/vault/:vaultId?`, `/item/:itemId`, `/generator`, `/shared`, `/settings/*`.
- **Responsive:** sidebar (vaults) + list + detail on desktop; stacked on mobile.
- **Accessibility:** keyboard navigation, focus management in dialogs, `aria-live` for the TOTP countdown at a low rate (announce only on code change).
- **No secrets in URLs, logs, `localStorage` or error reports.** Only non-sensitive UI preferences may be stored locally.

---

## 16. Build phases

Each phase ends with passing CI and a deployable app. Tick boxes as work lands (in the same commit).

### Phase 0: Scaffolding
- [x] Bun workspace root (`package.json` workspaces: `apps/*`, `packages/*`), `tsconfig.base.json` (strict), Biome config
- [x] `apps/api`: Hono app with `GET /api/health`, `wrangler.jsonc` (D1 binding `DB`, assets from `../web/dist`, `run_worker_first: ["/api/*"]`, SPA fallback `not_found_handling: "single-page-application"`, cron trigger), security headers middleware
- [x] `apps/web`: Vite + React + Tailwind + TanStack Router/Query, calls `/api/health`
- [x] `packages/shared`, `packages/crypto`, `packages/generator`, `packages/otp` with empty exports and a test each
- [x] Drizzle config for D1, local D1 via `wrangler dev` (no empty migration: the first migration comes with the Phase 2 schema)
- [x] Root scripts: `dev`, `build`, `test`, `lint`, `typecheck`, `db:generate`, `db:migrate:local`, `db:migrate:remote`, `deploy`
- [x] `.gitignore` (`node_modules`, `dist`, `.wrangler`, `.dev.vars`, `*.sqlite`, backups), `.dev.vars.example`
- [x] `ci.yml`: install, lint, typecheck, test, build
- [x] README quickstart
- [x] `deploy.yml`: on push to `master` → CI → apply D1 migrations → `wrangler deploy` (token in GitHub secrets)
- [ ] First deploy to `https://password-manager.azzaz.dev` (Custom Domain in `wrangler.jsonc`), `/api/health` returns OK. **Blocked on owner setup (section 18).** `deploy.yml` skips migrate/deploy with a notice until `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and a real `database_id` exist

### Phase 1: Core libraries (no UI, fully tested)
- [x] `packages/crypto`: sodium init, Argon2id derive, subkeys, envelope encrypt/decrypt with AAD, sealed boxes, recovery phrase (BIP39) generate/parse, key bundle builders for account creation/password change/recovery, fixed test vectors
- [x] `packages/generator`: unbiased random index, random mode, passphrase mode (EFF list), entropy calculation, property tests (distribution, set guarantees)
- [x] `packages/otp`: URI parse/normalise/validate, Base32, code generation, `remaining()`/`progress()`, RFC 6238/4226 vectors
- [x] `packages/shared`: zod schemas for item content and all API request/response bodies

### Phase 2: Accounts
- [x] D1 schema: users, invites, sessions, email_codes, auth_challenges, rate_limits, audit_events
- [x] Email sending via the Resend HTTP API with a dev mode that logs links/codes to the console; plain, text-first templates (invite, admin setup, recovery code, security notices)
- [x] Admin bootstrap: `/setup` page, `/setup/status`, `/setup/start` (10.0)
- [x] Invite acceptance: `/invite` page, `/invites/inspect`, `/auth/accept-invite`, recovery kit screen (10.1)
- [x] Admin console: send/resend/revoke invites, list users, disable/enable, change role (10.1a)
- [x] Prelogin with fake salts, login, sessions, logout (10.2)
- [x] Crypto worker + lock/unlock + auto-lock (10.3)
- [x] Change master password (10.4)
- [x] Rate limiting (D1-backed fixed windows: login 10/15 min per email, 30/15 min per IP; email codes 5/hour per email; invite inspect 20/15 min per IP; setup start 3/hour)
- [x] Origin check middleware (exact match), session middleware with `security_stamp` and `status = active`, admin-role middleware

### Phase 3: Personal vault
- [x] D1 schema: vaults, vault_members, items, deletions
- [x] Default vault created when the invite is accepted; create/rename/delete extra vaults
- [x] Item CRUD (login, note) with revision conflicts, trash/restore/purge
- [x] `/sync` full + incremental
- [x] UI: sidebar, item list with client-side search, item detail, item editor
- [x] Inline + standalone password generator UI
- [x] TOTP: add via URI/secret/QR (camera, upload, paste), live code + countdown ring, next-code preview, clock skew correction, codes in the list view
- [x] Copy with clipboard auto-clear, reveal toggles
- [x] Daily cron: purge trash > 30 days, expired sessions/codes/challenges, old audit events and tombstones

### Phase 4: Sharing
- [x] `/users/lookup`, invitations, accept/decline
- [x] Vault sharing with roles, server-side role enforcement
- [x] Single-item sharing
- [x] Revocation with key rotation (vault and item), `rotation_pending` recovery
- [x] Move item between vaults
- [x] "Shared with me" view, member management UI, leave vault

### Phase 5: Account security and recovery
- [x] Login TOTP (setup, enable, disable, replay protection)
- [x] Passkeys as second factor (`@simplewebauthn/server` verified in workerd with a software authenticator; browser ceremony not yet exercised by an automated test)
- [x] Backup codes
- [x] Recovery kit redemption (10.5 A) and regeneration
- [x] Reset from an unlocked device (10.5 B)
- [x] Reset account (10.5 D), by the user and by an admin (`/admin/users/:id/reset`)
- [x] Sessions list/revoke UI, activity log UI
- [x] Delete account (self and by admin)

Known gaps after Phases 3–4 (tracked for later): moving an item that has item shares is disabled in the UI; pending single-item invitations show no item name until accepted (the pending-shares API returns no item ciphertext); the main JS bundle is ~1.3 MB (zxcvbn dictionaries), code-splitting is a Phase 6 task.

### Phase 6: Production hardening
- [x] `backup.yml`: daily `wrangler d1 export --remote` → `age` encrypt → R2, 30-day lifecycle rule; documented restore drill (`scripts/restore.md`) and one test restore into a scratch D1 (the drill itself waits on owner setup)
- [ ] CSP and headers verified on both assets and API; `securityheaders.com`-style check
- [ ] Playwright E2E for admin setup → invite → accept → add item with TOTP → share → recipient sees it → revoke → change password → recover with kit
- [ ] Import (CSV formats) and export (encrypted JSON, CSV)
- [ ] Quota-exceeded handling and friendly error pages
- [ ] Code-split the main bundle (lazy-load zxcvbn, settings and admin)
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
| `packages/crypto` | Vitest | Round-trips, AAD mismatch fails, wrong key fails, fixed vectors (format stability), recovery phrase checksum, full account creation → password change → recovery simulation without a server |
| `packages/generator` | Vitest | Length/sets honoured, at-least-one-per-set, no ambiguous chars when excluded, chi-square-style distribution sanity check, entropy maths |
| `packages/otp` | Vitest | RFC 6238 + RFC 4226 vectors, URI parsing edge cases, countdown maths at period boundaries |
| `apps/api` | Vitest + `@cloudflare/vitest-plugin` (real workerd + local D1) | Every route: auth, role enforcement (viewer can't write, removed member gets 403), revision conflicts, rate limits, session invalidation via `security_stamp`, fake-salt prelogin |
| `apps/web` | Vitest + Testing Library | Generator UI, TOTP widget timing (fake timers), lock/unlock |
| End to end | Playwright | The Phase 6 journey across two browser contexts (two users), starting from admin bootstrap and an invite |

CI must pass before merge/deploy. Crypto code changes require new or updated tests in the same commit.

---

## 18. Deployment, operations and backups

Production URL: **`https://password-manager.azzaz.dev`**. One Worker named `password-manager` serves everything on that host: `/api/*` runs the Hono app, every other path is a static asset with SPA fallback to `index.html`. The `*.workers.dev` URL is disabled (`workers_dev: false`) so the app has exactly one origin.

`apps/api/wrangler.jsonc` (sketch):

```jsonc
{
  "name": "password-manager",
  "main": "src/index.ts",
  "compatibility_date": "<date of scaffolding>",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "<owner's account id, not secret>",
  "workers_dev": false,
  "routes": [{ "pattern": "password-manager.azzaz.dev", "custom_domain": true }],
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "password-manager", "database_id": "<id, not secret>", "migrations_dir": "migrations" }
  ],
  "triggers": { "crons": ["23 2 * * *"] },
  "vars": { "APP_ORIGIN": "https://password-manager.azzaz.dev", "ENVIRONMENT": "production" /* ...see section 19 */ }
}
```

Security headers on static assets come from `apps/web/public/_headers` (rule `/*`); API responses get them from middleware. The single source of truth is `SECURITY_HEADERS` in `packages/shared`, and a test fails if `_headers` drifts from it. Because `style-src 'self'` forbids inline `style=""` attributes, use Tailwind classes only.

### One-time owner setup

All of this can be done in the Cloudflare and GitHub dashboards; no local Wrangler login is required. **Secrets are entered directly into Cloudflare/GitHub, never pasted into chat, issues or commits.**

1. **Account ID:** Cloudflare dashboard → Workers & Pages → copy the Account ID (not secret; goes into `wrangler.jsonc`).
2. **Hostname:** make sure the `azzaz.dev` zone has **no existing DNS record** named `password-manager`. The Custom Domain creates its own record and certificate on first deploy.
3. **D1:** Storage & Databases → D1 → Create database `password-manager`. Copy its ID (not secret; goes into `wrangler.jsonc`).
4. **Deploy API token** (My Profile → API Tokens → Create Token → Custom token), name `pm-deploy`:

   | Scope | Resource | Permission | Why |
   |-------|----------|-----------|-----|
   | Account | Workers Scripts | Edit | Upload the Worker, assets, cron trigger |
   | Account | D1 | Edit | Apply migrations |
   | Account | Account Settings | Read | Wrangler reads account details |
   | Zone | Workers Routes | Edit | Attach the Custom Domain |
   | Zone | Zone | Read | Look up the `azzaz.dev` zone |

   Account resources: *Include → the owner's account*. Zone resources: *Include → Specific zone → `azzaz.dev`*. No IP filter (GitHub runner IPs vary). Optional expiry, e.g. 1 year with a calendar reminder.
5. **Backup API token** (Phase 6), name `pm-backup`: Account · D1 · Edit (export) and Account · Workers R2 Storage · Edit. Separate from the deploy token so each has the least access it needs.
6. **R2** (Phase 6): create bucket `pm-backups` with a lifecycle rule that deletes objects older than 30 days.
7. **GitHub** → repo Settings → Secrets and variables → Actions:
   - Secrets: `CLOUDFLARE_API_TOKEN` (pm-deploy), `CLOUDFLARE_BACKUP_API_TOKEN` (pm-backup, Phase 6).
   - Variables: `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_AGE_PUBLIC_KEY` (Phase 6; keep the matching `age` private key **offline**: in the owner's own password manager plus a printed copy).
8. **Resend:** add sending domain `password-manager.azzaz.dev` and create the DNS records Resend shows (SPF/MX on `send.password-manager.azzaz.dev`, DKIM TXT on `resend._domainkey.password-manager.azzaz.dev`) in Cloudflare DNS as **DNS only** (grey cloud), or use Resend's Cloudflare auto-configure. These are DNS records, not HTTPS hostnames, so the one-level SSL limit doesn't apply. If Resend's single free domain is already used for `azzaz.dev`, reuse it and send from `password-manager@azzaz.dev` instead. Create an API key with **Sending access** restricted to that domain.
9. **Worker secrets** (after the first deploy creates the Worker): Workers & Pages → `password-manager` → Settings → Variables and Secrets → add each as type *Secret*: `RESEND_API_KEY`, `AUTH_PEPPER`, `FAKE_SALT_KEY`, `SERVER_ENC_KEY` (see [section 19](#19-configuration-reference)). Secrets survive later deploys. Until they exist, the API fails closed with `503 server_misconfigured`.
10. Open `https://password-manager.azzaz.dev/setup` and send yourself the admin setup link (10.0).

### Deploy
- `deploy.yml` on push to `master`: install → lint/typecheck/test → build web → `wrangler d1 migrations apply password-manager --remote` → `wrangler deploy`. Uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- A manual `bun run deploy` from a machine with `wrangler login` does the same steps (fallback only).
- Migrations must be backward compatible with the currently deployed code (add columns before using them; drop in a later release), because migrations run just before the new code goes live.

### Backups and restore
- Daily (`backup.yml`, cron `17 3 * * *`, uses `CLOUDFLARE_BACKUP_API_TOKEN`): `wrangler d1 export password-manager --remote --output=dump.sql` → `age -r $BACKUP_AGE_PUBLIC_KEY` → `wrangler r2 object put pm-backups/YYYY-MM-DD.sql.age`. Delete the plaintext dump in the same step.
- Fast restore for the last 7 days: D1 Time Travel (`wrangler d1 time-travel restore`).
- Older: download from R2, decrypt with the offline `age` key, `wrangler d1 execute <db> --remote --file=dump.sql` into a fresh database, switch the binding.
- Practise a restore once per quarter.

### Monitoring
- Workers dashboard analytics (free) for errors and request counts.
- `wrangler tail` for live logs. Logs must never contain request bodies, keys, verifiers, tokens or codes.
- Optional: a daily GitHub Action that calls `/api/health` and opens an issue on failure.

---

## 19. Configuration reference

### Worker bindings (`wrangler.jsonc`)
| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Main database |
| `ASSETS` | Static assets | SPA build |

### Worker vars (non-secret, in `wrangler.jsonc`)
Vars set in the dashboard are overwritten on deploy, so they live in `wrangler.jsonc` only.

| Name | Value | Purpose |
|------|-------|---------|
| `APP_ORIGIN` | `https://password-manager.azzaz.dev` | Exact Origin check, links in emails, WebAuthn RP ID (`password-manager.azzaz.dev`) |
| `ENVIRONMENT` | `production` (local: `development`, tests: `test`) | Anything else fails closed (503). Outside production, emails go to an in-memory outbox (development also logs them) and the session cookie drops the `__Host-`/`Secure` requirements |
| `ADMIN_EMAIL` | owner's email (see [section 20](#20-open-questions-for-the-owner)) | Recipient of the one-time admin setup invite (10.0) |
| `INVITE_TTL_HOURS` | `72` | Invite link lifetime |
| `KDF_DEFAULT_MEM` | `67108864` | 64 MiB |
| `KDF_DEFAULT_OPS` | `3` | |
| `EMAIL_FROM` | `Password Manager <no-reply@password-manager.azzaz.dev>` | Must be on the Resend-verified domain |

### Worker secrets (dashboard or `wrangler secret put`; locally in `apps/api/.dev.vars`)
| Name | Purpose | How to generate |
|------|---------|-----------------|
| `AUTH_PEPPER` | HMAC key for `auth_verifier` and `recovery_verifier` | 32 random bytes, base64url |
| `FAKE_SALT_KEY` | Deterministic fake salts for unknown emails | 32 random bytes |
| `SERVER_ENC_KEY` | AES-256-GCM key for login TOTP secrets | 32 random bytes |
| `RESEND_API_KEY` | Email sending (Resend HTTP API, sending access only) | Resend dashboard |

**Never rotate `AUTH_PEPPER` casually:** every user's verifier depends on it. Rotation would need a dual-pepper migration (verify with old, rewrite with new on next login). Store a copy of each generated secret in the owner's own offline records; losing `AUTH_PEPPER` means nobody can log in (data isn't lost: users could recover through 10.5 A once a new pepper is set and verifiers are rebuilt).

Generate a secret: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

Local development (`apps/api/.dev.vars`, never committed) uses throwaway values and needs no Resend key: in `development` emails are printed to the console.

### GitHub Actions configuration
| Kind | Name | Used by |
|------|------|---------|
| Secret | `CLOUDFLARE_API_TOKEN` | `deploy.yml` |
| Secret | `CLOUDFLARE_BACKUP_API_TOKEN` | `backup.yml` |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | both |
| Variable | `BACKUP_AGE_PUBLIC_KEY` | `backup.yml` |

---

## 20. Open questions for the owner

Answered (October 2026):
- **Registration:** invite-only; super admin bootstrapped via setup link (10.0).
- **Domain:** `password-manager.azzaz.dev`, single origin with `/api` prefix.
- **Email:** Resend, HTTP API key (not SMTP).
- **Repository:** private; deploy from GitHub Actions with Wrangler.

Still open:
1. **`ADMIN_EMAIL`:** which address receives the admin setup link? (It is committed in `wrangler.jsonc`; use a var override if that's unwanted.)
2. **Resend domain:** verify `password-manager.azzaz.dev`, or is the free domain slot already used for `azzaz.dev`?
3. **Account ID and D1 database ID** for `wrangler.jsonc` (neither is secret).
4. **Expected number of users.** Sizing assumes up to ~100 users / ~50k items, far inside the free limits.

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
| **AK (account key)** | Random key created at account creation that protects the user's private key; wrapped by wrapKey and by the recovery key |
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

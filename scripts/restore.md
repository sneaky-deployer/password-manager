# Backup and restore runbook

Plain steps for restoring the password manager's D1 database. Read the whole page once before you
need it. Practise it every quarter (section 3), so the first real restore is not also the first try.

Background: `.github/workflows/backup.yml` runs daily at 03:17 UTC. It exports D1, encrypts the
export with `age`, and uploads `pm-backups/YYYY-MM-DD.sql.age` to R2. A lifecycle rule on the
bucket deletes objects after 30 days. D1 Time Travel covers the last 7 days on top of that.
If a daily run fails, the run turns red in GitHub Actions. Treat a red backup run as an incident.

All commands run from `apps/api` (so Wrangler reads `wrangler.jsonc`). Wrangler needs credentials:
either `bunx wrangler login`, or `export CLOUDFLARE_API_TOKEN=...` and
`export CLOUDFLARE_ACCOUNT_ID=...`. The `pm-backup` token (D1 Edit + R2 Edit) is enough for every
step below. Never paste a token into a chat, an issue or a commit.

Do all work with plaintext dumps in a private folder **outside the repository**, for example:

```bash
umask 077
mkdir -p ~/pm-restore                         # plaintext dumps and key.txt go here, never in the repo
```

`.gitignore` only covers `backups/`, `*.sqlite*` and `.dev.vars`. It does not cover `dump.sql` or
`*.age`, so keep them out of the repo entirely.

---

## 1. Fast path: D1 Time Travel (last 7 days)

Use this when the live database was damaged recently (bad migration, bug, accidental deletion) and
you know roughly when it was last good.

> **Warning: `restore` overwrites the live database in place.** Everything written after the chosen
> point in time is gone: new items, new users, password changes, sessions. Time Travel returns the
> previous bookmark when you restore, so you can undo the restore. Write that bookmark down.

```bash
cd apps/api

# 1. Look at the database as of a timestamp. Prints a bookmark. Changes nothing.
bunx wrangler d1 time-travel info password-manager --timestamp="2026-10-27T10:00:00Z"

# Without --timestamp it shows the current bookmark (note it before restoring, as an undo point).
bunx wrangler d1 time-travel info password-manager

# 2. Restore. Pick ONE of --timestamp or --bookmark. Wrangler asks for confirmation.
bunx wrangler d1 time-travel restore password-manager --timestamp="2026-10-27T10:00:00Z"
# or
bunx wrangler d1 time-travel restore password-manager --bookmark=<bookmark-from-info>
```

Timestamps are RFC3339 (`2026-10-27T10:00:00Z`) or Unix seconds. The Wrangler help text mentions 30
days, which is the paid-plan window; on the free plan the window is 7 days.

After the restore:
1. Open `https://password-manager.azzaz.dev/api/health` and sign in with an account.
2. Read "After any restore" at the end of section 2.

If the point you need is older than 7 days, use section 2.

---

## 2. Older backups: restore from R2

### 2.1 Find and download the backup

Objects are named by UTC date: `pm-backups/2026-10-27.sql.age`. To list them, open the Cloudflare
dashboard: R2 → `pm-backups` → Objects. (Wrangler has no list command for objects.)

```bash
cd apps/api
bunx wrangler r2 object get pm-backups/2026-10-27.sql.age --file="$HOME/pm-restore/backup.sql.age" --remote
```

### 2.2 Decrypt with the offline age private key

Get `key.txt` from where you stored it (section 4). It must not live in the repo.

```bash
cd ~/pm-restore
age -d -i key.txt -o dump.sql backup.sql.age
head -c 300 dump.sql          # should start with SQL (PRAGMA / CREATE TABLE), not binary
```

If `age` says "no identity matched any of the file's recipients", the file was encrypted to a
different public key than this `key.txt`. Try the other key you may have used.

### 2.3 Restore into a scratch database

The export contains the schema (`CREATE TABLE`, indexes) **and** the data, which should include the
`d1_migrations` table (check in 2.4). So restore into an **empty** database. Do not run migrations first; the
`CREATE TABLE` statements would fail with "table already exists".

```bash
cd apps/api
bunx wrangler d1 create pm-restore-20261028              # use today's date; prints a database_id
bunx wrangler d1 execute pm-restore-20261028 --remote --file="$HOME/pm-restore/dump.sql" --yes
```

`d1 execute` finds a database that is not in `wrangler.jsonc` through the Cloudflare API by name, so
you do not need to edit the config for this step. The database is unavailable while the file
imports. That is fine for a scratch database.

### 2.4 Verify

```bash
bunx wrangler d1 execute pm-restore-20261028 --remote --command \
  "SELECT 'users' AS t, COUNT(*) AS n FROM users
   UNION ALL SELECT 'vaults', COUNT(*) FROM vaults
   UNION ALL SELECT 'vault_members', COUNT(*) FROM vault_members
   UNION ALL SELECT 'items', COUNT(*) FROM items
   UNION ALL SELECT 'item_shares', COUNT(*) FROM item_shares"

bunx wrangler d1 execute pm-restore-20261028 --remote --command \
  "SELECT name FROM d1_migrations ORDER BY id"
```

Check that:
- The counts are plausible. Run the same count query against `password-manager` (the live database)
  and compare. The backup should be equal to or slightly lower than live (rows added since the backup).
- `d1_migrations` lists every file in `apps/api/migrations/` that existed on the backup date. If the
  table is missing or empty, the next deploy's `migrations apply` would try to re-run `0000_init.sql`
  and fail. In that case insert the rows by hand or ask for help before going live.
- A known user exists: `SELECT email, role, status FROM users;` (this prints emails; do it on your
  own machine only).

### 2.5 Go live with the restored data

There are two ways. Option A keeps the database name `password-manager`, so `deploy.yml` and
`backup.yml` keep working unchanged. Prefer it.

**Option A: recreate `password-manager` and load the dump into it.**
Only do this after 2.4 passed and `dump.sql` is safe. Deleting a D1 database also deletes its Time
Travel history, and cannot be undone.

```bash
cd apps/api
bunx wrangler d1 export password-manager --remote --output="$HOME/pm-restore/live-before-restore.sql"  # last-chance copy of the broken state
bunx wrangler d1 delete password-manager
bunx wrangler d1 create password-manager                # prints the NEW database_id
bunx wrangler d1 execute password-manager --remote --file="$HOME/pm-restore/dump.sql" --yes
```

Then put the new id in `apps/api/wrangler.jsonc` (`d1_databases[0].database_id`), commit, and push to
`master`. `deploy.yml` applies migrations (a no-op if `d1_migrations` came across) and deploys the
Worker bound to the new database. The site returns errors between the delete and the deploy.

**Option B: switch to the scratch database as it is.**
No deletion, so no downtime from a delete, but the name differs. In `apps/api/wrangler.jsonc` set
both `database_name` and `database_id` to the scratch database's values, and change the hard-coded
name `password-manager` in `.github/workflows/deploy.yml` (`d1 migrations apply`) and
`.github/workflows/backup.yml` (`d1 export`). Push to `master`. The old database stays untouched
until you delete it.

### 2.6 After any restore (sections 1 and 2)

A restore rolls back everything after the chosen point. Check these:
- Worker secrets are **not** in the backup. `AUTH_PEPPER`, `FAKE_SALT_KEY` and `SERVER_ENC_KEY` must be
  the same values the data was written with. A new pepper means nobody can log in; a new
  `SERVER_ENC_KEY` makes stored login-TOTP secrets unreadable. Use your offline copies.
- Sessions in the restored data may include ones that were revoked after the backup. Invalidate all
  of them: `DELETE FROM sessions;` and `DELETE FROM auth_challenges;` (via `wrangler d1 execute
  password-manager --remote --command "..."`). Everyone signs in again.
- Anything users did after the backup is lost: new items, password changes, new invites, share and
  member **revocations** (a revoked user may have access again). Tell users, and re-apply
  revocations and removals you know about.
- Delete the plaintext files when finished (section 2.7).

### 2.7 Clean up

```bash
cd ~/pm-restore
shred -u dump.sql live-before-restore.sql backup.sql.age 2>/dev/null || rm -f dump.sql live-before-restore.sql backup.sql.age
cd <path-to-repo>/apps/api && bunx wrangler d1 delete pm-restore-20261028   # once nothing points at it
```

Do not delete `key.txt` from your offline storage. Remove only the working copy you fetched.

---

## 3. Restore drill (quarterly)

Goal: prove that the newest backup decrypts and loads, and that you remember how.

1. Download the latest object (2.1) and decrypt it (2.2). The newest object should be yesterday's or
   today's date. If it is older, the backup job is failing; fix that first.
2. Create a scratch database and load the dump (2.3). Never run this against `password-manager`.
3. Verify counts and migrations (2.4).
4. Delete the scratch database and the plaintext files (2.7).
5. Note the date and result somewhere you will see it next quarter.

### Testing the dump locally (no Cloudflare database needed)

Useful for checking a dump without touching any remote database. Load into a **fresh, separate**
local state directory, not your normal dev database, because the dump creates the tables itself:

```bash
cd apps/api
bunx wrangler d1 execute password-manager --local --persist-to="$HOME/pm-restore/local-state" --file="$HOME/pm-restore/dump.sql"
bunx wrangler d1 execute password-manager --local --persist-to="$HOME/pm-restore/local-state" --command \
  "SELECT COUNT(*) AS users FROM users"
rm -rf "$HOME/pm-restore/local-state"
```

Do not run `bun run db:migrate:local` first for this: it creates the tables, and the dump's
`CREATE TABLE` statements would then fail. If you want to use the restored data with `wrangler dev`,
start from an empty local state (delete `apps/api/.wrangler/state/v3/d1`), load the dump with the
command above but without `--persist-to`, and do not run migrations.

---

## 4. Generating the age keypair (once)

Do this on a machine you trust, ideally not the one that holds your regular browser sessions.

```bash
umask 077
age-keygen -o key.txt
# prints: Public key: age1...   (the public key; key.txt holds the private key AGE-SECRET-KEY-1...)
```

1. Copy the **public key** (`age1...`) into the GitHub repository variable `BACKUP_AGE_PUBLIC_KEY`
   (Settings → Secrets and variables → Actions → Variables). It is not secret.
2. Store `key.txt` (the private key) **offline and outside this app**:
   - in your own, separate password manager or encrypted storage, and
   - as a printed copy in a safe place.

   Do not store the only copy inside this password manager: if the app is down or its data is gone,
   you could not reach the key needed to restore it. Never put it in the repo, in GitHub secrets or
   variables, or in chat.
3. Test the pair before relying on it:
   ```bash
   echo hello | age -r age1...yourpublickey > t.age && age -d -i key.txt t.age   # prints: hello
   rm t.age
   ```
4. Delete the working `key.txt` from the machine (`shred -u key.txt`) once both copies are stored.
5. Run the workflow once by hand (Actions → Backup → Run workflow) and do a drill (section 3) to confirm
   the first real backup decrypts with your stored key.

Other one-time setup the backup needs: the R2 bucket `pm-backups` with a 30-day lifecycle rule, the
`pm-backup` API token (Account · D1 · Edit and Account · Workers R2 Storage · Edit) stored as the
secret `CLOUDFLARE_BACKUP_API_TOKEN`, the variable `CLOUDFLARE_ACCOUNT_ID`, and a real `database_id`
in `apps/api/wrangler.jsonc`. Until all of them exist the workflow prints a notice and skips.

To rotate the key: generate a new pair, update `BACKUP_AGE_PUBLIC_KEY`, and keep the old private key
until the last backup encrypted with it has expired (30 days).

---

## 5. What a backup contains, and what it cannot do

**Contains** the whole D1 database:
- Vault and item data as **ciphertext**: the server never had the keys, so the dump alone does not
  reveal passwords or notes.
- Still sensitive: user emails, roles and status, KDF salts and parameters, `auth_verifier` and
  `recovery_verifier` (HMACs of client-derived values), wrapped and sealed keys (`wrapped_ak_pw`,
  `wrapped_ak_rec`, `encrypted_private_key`, `sealed_key`), encrypted login-TOTP secrets, passkey
  public keys, session token hashes, and audit events. An attacker with the dump could try offline
  guessing against the master-password-derived values. That is why the dump is `age`-encrypted and why
  plaintext dumps must be deleted right away.

**Cannot do:**
- It cannot restore anyone's master password or recovery phrase. If a user forgot both, their vault
  stays unreadable, backup or not. They need their recovery kit (PLAN.md section 10.5).
- It does not contain Worker secrets (`AUTH_PEPPER`, `FAKE_SALT_KEY`, `SERVER_ENC_KEY`,
  `RESEND_API_KEY`) or `wrangler.jsonc`. Keep offline copies of the secrets; without the original
  `AUTH_PEPPER` nobody can log in to the restored data.
- It is a snapshot from about 03:17 UTC on the named day. Later changes are not in it.
- It does not protect against losing the age private key. Without `key.txt`, the R2 backups are
  unreadable; Time Travel (7 days) is then the only restore path.

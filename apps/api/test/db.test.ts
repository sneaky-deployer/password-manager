import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { itemShares, items, sessions, users, vaultMembers, vaults } from "../src/db/schema.ts";
import {
  createItem,
  createTestSession,
  createUser,
  createVaultWithOwner,
  db,
  resetDb,
} from "./helpers.ts";

const TABLES = [
  "users",
  "sessions",
  "webauthn_credentials",
  "backup_codes",
  "invites",
  "email_codes",
  "auth_challenges",
  "vaults",
  "vault_members",
  "vault_rotation_items",
  "items",
  "item_shares",
  "rate_limits",
  "audit_events",
  "deletions",
];

describe("database", () => {
  beforeEach(resetDb);

  it("has every table from the migrations", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual([...TABLES].sort());
  });

  it("creates the unique indexes the routes rely on", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE%'",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const expected of [
      "users_email_unique",
      "sessions_token_hash_uq",
      "invites_token_hash_uq",
      "vault_members_vault_user_uq",
      "item_shares_item_user_uq",
      "webauthn_credentials_credential_id_uq",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("resetDb empties every table", async () => {
    const user = await createUser();
    await createTestSession(user);
    const { vault } = await createVaultWithOwner(user);
    await createItem(vault, user);
    await resetDb();
    for (const table of TABLES) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{
        n: number;
      }>();
      expect(row?.n, table).toBe(0);
    }
  });

  it("enforces unique emails", async () => {
    const user = await createUser({ email: "dup@example.test" });
    await expect(createUser({ email: user.email })).rejects.toThrow();
  });

  it("cascades deletes from users to everything they own", async () => {
    const user = await createUser();
    const other = await createUser();
    await createTestSession(user);
    const { vault } = await createVaultWithOwner(user);
    const item = await createItem(vault, user);
    await db.insert(itemShares).values({
      id: crypto.randomUUID(),
      itemId: item.id,
      userId: other.id,
      role: "viewer",
      keyVersion: 1,
      sealedKey: "x",
      createdAt: 1,
      updatedAt: 1,
    });

    await db.delete(users).where(eq(users.id, user.id));

    expect(await db.select().from(sessions)).toHaveLength(0);
    expect(await db.select().from(vaults)).toHaveLength(0);
    expect(await db.select().from(vaultMembers)).toHaveLength(0);
    expect(await db.select().from(items)).toHaveLength(0);
    expect(await db.select().from(itemShares)).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
